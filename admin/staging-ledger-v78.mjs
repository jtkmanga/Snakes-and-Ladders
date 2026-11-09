import { DurableObject } from 'cloudflare:workers';
import { PaymentV2AtomicLedger } from './payments-v2/atomic-ledger.mjs';
import {PaymentV2BuyerPreviewLedger} from './payments-v2/buyer-preview-ledger.mjs';
import {PaymentV2LiveCoordinator} from './payments-v2/live-controller.mjs';
import {checkedPrices,currentPrices} from './admin/prices.mjs';
import {verifyOrderV2,deliverVerifiedOrderV2} from './payments-v2/server-coordinator.mjs';
import {PRODUCTS,ORDER_LIFETIME_MS,RECEIPT_RECOVERY_MS} from './payments.js';
export class PaymentLedger extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, sku TEXT NOT NULL, amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL, lock_until INTEGER NOT NULL DEFAULT 0,
      tx_hash TEXT, fulfilled_at INTEGER
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS transfers (fingerprint TEXT PRIMARY KEY, order_id TEXT NOT NULL)`);
  }
  // Separate v2-sandbox-only Durable Object instance, never the v1 transaction ledger.
  initV2Sandbox(){
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS v2_sandbox_orders (id TEXT PRIMARY KEY, uid TEXT NOT NULL, sku TEXT NOT NULL, amount INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status='test_only'))");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_v2_sandbox_uid_date ON v2_sandbox_orders(uid,created_at)");
  }
  createV2Sandbox({id,uid,sku}){
    if(typeof uid!=='string'||uid.length<1||uid.length>128||
      typeof id!=='string'||!/^test-v2-[a-f0-9-]{36}$/.test(id)||
      !Object.prototype.hasOwnProperty.call(PRODUCTS,sku))return {ok:false,reason:'invalid_test_order'};
    this.initV2Sandbox();
    const now=Date.now();
    const existing=this.ctx.storage.sql.exec("SELECT * FROM v2_sandbox_orders WHERE uid=? AND sku=? AND expires_at>? AND status='test_only' ORDER BY created_at DESC LIMIT 1",uid,sku,now).toArray()[0];
    if(existing)return {ok:true,reused:true,order:existing};
    const count=this.ctx.storage.sql.exec("SELECT COUNT(*) AS total FROM v2_sandbox_orders WHERE uid=? AND created_at>?",uid,now-86400000).toArray()[0]?.total||0;
    if(Number(count)>=12)return {ok:false,reason:'sandbox_rate_limited'};
    this.ctx.storage.sql.exec("INSERT INTO v2_sandbox_orders(id,uid,sku,amount,created_at,expires_at,status) VALUES(?,?,?,?,?,?,'test_only')",id,uid,sku,PRODUCTS[sku].amount,now,now+900000);
    const order=this.ctx.storage.sql.exec("SELECT * FROM v2_sandbox_orders WHERE id=? AND uid=?",id,uid).toArray()[0];
    return {ok:true,reused:false,order};
  }
  listV2Sandbox({uid}){
    if(typeof uid!=='string'||uid.length<1||uid.length>128)return [];
    this.initV2Sandbox();
    return this.ctx.storage.sql.exec("SELECT * FROM v2_sandbox_orders WHERE uid=? ORDER BY created_at DESC LIMIT 6",uid).toArray();
  }
  // Simulated transfers only; this lives in the isolated payment-v2-sandbox-only DO.
  initV2MockReplay(){
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS v2_mock_transfers (reference TEXT PRIMARY KEY, order_id TEXT NOT NULL, uid TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_v2_mock_uid_time ON v2_mock_transfers(uid,created_at)");
  }
  runV2MockReplay({uid,runId}){
    if(typeof uid!=='string'||uid.length<1||uid.length>128||
       typeof runId!=='string'||!/^mock-run-[0-9a-f-]{36}$/.test(runId))
       return {ok:false,reason:'bad_mock_input'};
    this.initV2Sandbox();this.initV2MockReplay();
    const now=Date.now();
    const count=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS total FROM v2_mock_transfers WHERE uid=? AND created_at>?",uid,now-86400000).toArray()[0]?.total||0);
    if(count>=12)return {ok:false,reason:'mock_rate_limit'};
    const created=this.createV2Sandbox({id:"test-v2-"+crypto.randomUUID(),uid,sku:"shield"});
    if(!created?.ok)return {ok:false,reason:created?.reason||'test_order_unavailable'};
    const order=created.order;
    if(order.uid!==uid||order.sku!=='shield'||order.amount!==10||order.status!=='test_only')
      return {ok:false,reason:'invalid_test_order'};
    const reference="FAKE_ONLY_"+runId;
    const check=({providerCode="200200",amount=order.amount,receiver="02004",at=now}={})=>{
      if(providerCode!=='200200')return 'unverified_slip';
      if(receiver!=='02004')return 'wrong_receiver';
      if(amount!==order.amount)return 'wrong_amount';
      if(at<order.created_at||at>order.expires_at)return 'expired_order';
      const used=this.ctx.storage.sql.exec("SELECT reference FROM v2_mock_transfers WHERE reference=?",reference).toArray()[0];
      if(used)return 'duplicate_transfer';
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO v2_mock_transfers(reference,order_id,uid,created_at,status) VALUES(?,?,?,?,?)",reference,order.id,uid,now,"test_only");
      return 'mock_verified_only';
    };
    const cases=[
      {name:'mock_valid',expected:'mock_verified_only',result:check()},
      {name:'duplicate_transfer',expected:'duplicate_transfer',result:check()},
      {name:'wrong_amount',expected:'wrong_amount',result:check({amount:order.amount+1})},
      {name:'wrong_receiver',expected:'wrong_receiver',result:check({receiver:'02001'})},
      {name:'unverified_slip',expected:'unverified_slip',result:check({providerCode:'200000'})},
      {name:'expired_order',expected:'expired_order',result:check({at:order.expires_at+1})}
    ];
    const persisted=Boolean(this.ctx.storage.sql.exec("SELECT reference FROM v2_mock_transfers WHERE reference=?",reference).toArray()[0]);
    const passed=cases.every(x=>x.expected===x.result)&&persisted;
    return {ok:passed,orderId:order.id,amountBaht:order.amount,
      checks:cases.map(x=>({name:x.name,passed:x.expected===x.result})),persisted,
      synthetic:true,providerCalled:false,entitlementsModified:false};
  }
  listV2MockReplay({uid}){
    if(typeof uid!=='string'||uid.length<1||uid.length>128)return {total:0,last:[]};
    this.initV2MockReplay();
    const total=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS total FROM v2_mock_transfers WHERE uid=?",uid).toArray()[0]?.total||0);
    const rows=this.ctx.storage.sql.exec("SELECT order_id,created_at,status FROM v2_mock_transfers WHERE uid=? ORDER BY created_at DESC LIMIT 6",uid).toArray();
    return {total,last:rows.map(x=>({testOrderId:x.order_id,createdAt:x.created_at,status:x.status}))};
  }
  // Synthetic tests are restricted to payment-v2-atomic-sandbox-v1 DO.
  atomicSandboxInit(){
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS v2_smoke_history (id TEXT PRIMARY KEY,owner TEXT NOT NULL,created_at INTEGER NOT NULL,passed INTEGER NOT NULL)");
  }
  atomicSandboxHistory({uid}){
    this.atomicSandboxInit();
    const rows=this.ctx.storage.sql.exec("SELECT created_at,passed FROM v2_smoke_history WHERE owner=? ORDER BY created_at DESC LIMIT 6",uid).toArray();
    return {count:Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_smoke_history WHERE owner=?",uid).toArray()[0]?.n||0),
      entries:rows.map(x=>({at:x.created_at,passed:x.passed===1}))};
  }
  atomicSandboxSmoke({uid,runId}){
    if(typeof uid!=="string"||uid.length<4||uid.length>128||typeof runId!=="string"||!/^mock-run-[a-f0-9-]{36}$/.test(runId))return {ok:false,reason:"invalid_test"};
    this.atomicSandboxInit();
    const now=Date.now();
    const count=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_smoke_history WHERE owner=? AND created_at>?",uid,now-86400000).toArray()[0]?.n||0);
    if(count>=12)return {ok:false,reason:"test_rate_limited"};
    const l=new PaymentV2AtomicLedger(this.ctx.storage);
    const a=l.createPending({uid:"mockPlayerA",sku:"shield",uuid:crypto.randomUUID()});
    const b=l.createPending({uid:"mockPlayerB",sku:"win2",uuid:crypto.randomUUID()});
    if(!a.ok||!b.ok)return {ok:false,reason:"mock_order_failed"};
    const first=a.order,second=b.order,t1=crypto.randomUUID(),t2=crypto.randomUUID();
    const p=l.beginVerification({id:first.id,uid:first.uid,attemptId:t1});
    const q=l.beginVerification({id:second.id,uid:second.uid,attemptId:t2});
    if(!p.ok||!q.ok)return {ok:false,reason:"mock_lock_failed"};
    const hash=runId.slice(9).replace(/-/g,"")+"0".repeat(32);
    const e1={verifiedBy:"provider_200200",orderId:first.id,amountBaht:first.amount,transferredAt:now,fingerprint:hash};
    const e2={verifiedBy:"provider_200200",orderId:second.id,amountBaht:second.amount,transferredAt:now,fingerprint:hash};
    const one=l.providerVerified({id:first.id,uid:first.uid,attemptId:t1,event:e1});
    const same=l.providerVerified({id:first.id,uid:first.uid,attemptId:t1,event:e1});
    const invalid=l.providerVerified({id:second.id,uid:second.uid,attemptId:t2,event:{...e2,amountBaht:999}});
    const duplicate=l.providerVerified({id:second.id,uid:second.uid,attemptId:t2,event:e2});
    const delivery=l.claimDelivery({id:first.id,uid:first.uid});
    const stale=l.markFulfilled({id:first.id,uid:first.uid,attempt:Number(delivery.attempt)+1});
    const finished=l.markFulfilled({id:first.id,uid:first.uid,attempt:delivery.attempt});
    const again=l.claimDelivery({id:first.id,uid:first.uid});
    const checks=[
      {name:"verified_transaction",passed:one.ok===true},
      {name:"same_order_idempotent",passed:same.idempotent===true},
      {name:"wrong_amount_rejected",passed:invalid.reason==="amount_or_time_mismatch"},
      {name:"cross_player_replay_blocked",passed:duplicate.reason==="duplicate_transfer"},
      {name:"stale_attempt_blocked",passed:stale.reason==="stale_delivery_attempt"},
      {name:"fulfillment_state_once",passed:delivery.ok===true&&finished.fulfilled===true&&again.alreadyFulfilled===true}
    ];
    const passed=checks.every(x=>x.passed);
    this.ctx.storage.sql.exec("INSERT INTO v2_smoke_history(id,owner,created_at,passed) VALUES(?,?,?,?)",runId,uid,now,passed?1:0);
    return {ok:passed,checks,synthetic:true,stored:true,providerCalled:false,rightsGranted:false};
  }
  // Admin-only isolated E2E simulation; fake provider and fake VIP receipts only.
  initV2E2EMock(){
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS v2_e2e_mock_history (id TEXT PRIMARY KEY,owner TEXT NOT NULL,created_at INTEGER NOT NULL,passed INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS v2_e2e_fake_vip (receipt TEXT PRIMARY KEY,uid TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  }
  async runV2E2EMock({uid,runId}){
    if(typeof uid!=="string"||uid.length<4||uid.length>128||typeof runId!=="string"||!/^mock-run-[a-f0-9-]{36}$/.test(runId))return {ok:false,reason:"invalid_test"};
    this.initV2E2EMock();
    const now=Date.now();
    const count=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_e2e_mock_history WHERE owner=? AND created_at>?",uid,now-86400000).toArray()[0]?.n||0);
    if(count>=12)return {ok:false,reason:"test_rate_limited"};
    const ledger=new PaymentV2AtomicLedger(this.ctx.storage);
    const aUid="sandboxA"+runId.slice(9).replace(/-/g,"");
    const bUid="sandboxB"+runId.slice(9).replace(/-/g,"");
    const cUid="sandboxC"+runId.slice(9).replace(/-/g,"");
    const a=ledger.createPending({uid:aUid,sku:"vip",uuid:crypto.randomUUID()});
    const b=ledger.createPending({uid:bUid,sku:"vip",uuid:crypto.randomUUID()});
    const c=ledger.createPending({uid:cUid,sku:"shield",uuid:crypto.randomUUID()});
    if(!a.ok||!b.ok||!c.ok)return {ok:false,reason:"mock_order_failed"};
    const testEnv={PAYMENTS_ENABLED:"false",PAYMENT_ROLLOUT:"disabled",MERCHANT_ACCOUNT_TYPE:"02004",MERCHANT_ACCOUNT_NUMBER:"000000000000000",SLIP2GO_V2_SECRET:"TEST_ONLY_NOT_REAL_SECRET"};
    const fakeImage=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0]);
    const fakeTransfer="TESTONLY"+runId.slice(9).replace(/-/g,"");
    const mockProvider=(code,amount)=>async (url,options)=>{
      if(url!=="https://connect.slip2go.com/api/verify-slip/qr-image/info"||
        options.headers.Authorization!=="Bearer TEST_ONLY_NOT_REAL_SECRET"||
        options.body.get("file").type!=="image/png")throw Error("mock_transport_mismatch");
      const payload=JSON.parse(options.body.get("payload"));
      if(payload.checkDuplicate!==true||payload.checkReceiver?.[0]?.accountType!=="02004"||
        payload.checkReceiver?.[0]?.accountNumber!=="000000000000000"||
        payload.checkAmount?.amount!==String(amount))throw Error("mock_provider_conditions_mismatch");
      return {status:200,ok:true,json:async()=>({code,data:{amount,transRef:fakeTransfer,
        dateTime:new Date(now).toISOString(),sender:{bank:{id:"004"}}}})};
    };
    const verifyA=await verifyOrderV2({ledger,userId:aUid,orderId:a.order.id,bytes:fakeImage,env:testEnv,
      fetchFn:mockProvider("200200",100),now:now+1000,uuid:()=>crypto.randomUUID()});
    const duplicate=await verifyOrderV2({ledger,userId:bUid,orderId:b.order.id,bytes:fakeImage,env:testEnv,
      fetchFn:mockProvider("200200",100),now:now+1000,uuid:()=>crypto.randomUUID()});
    const unverified=await verifyOrderV2({ledger,userId:cUid,orderId:c.order.id,bytes:fakeImage,env:testEnv,
      fetchFn:mockProvider("200000",10),now:now+1000,uuid:()=>crypto.randomUUID()});
    let reserved=false,grantCalls=0;
    const fakeVip={
      reserveForCheckout:async()=>{reserved=true;return {ok:true};},
      activateAfterVerifiedPayment:async({userId,transactionId})=>{
        grantCalls++;
        const old=this.ctx.storage.sql.exec("SELECT * FROM v2_e2e_fake_vip WHERE receipt=?",transactionId).toArray()[0];
        if(old)return old.uid===userId?{ok:true,alreadyApplied:true,expiresAt:old.expires_at}:{ok:false,reason:"duplicate_receipt"};
        if(!reserved)return {ok:false,reason:"missing_or_expired_hold"};
        const expiry=now+2592000000;
        this.ctx.storage.sql.exec("INSERT INTO v2_e2e_fake_vip(receipt,uid,expires_at) VALUES(?,?,?)",transactionId,userId,expiry);
        return {ok:true,expiresAt:expiry};
      }
    };
    const realMark=ledger.markFulfilled.bind(ledger);
    let crash=true;
    ledger.markFulfilled=(args)=>{if(crash){crash=false;throw Error("synthetic_crash_after_fake_grant")}return realMark(args);};
    const first=await deliverVerifiedOrderV2({ledger,userId:aUid,orderId:a.order.id,vip:fakeVip});
    ledger.markFulfilled=realMark;
    const recovered=await deliverVerifiedOrderV2({ledger,userId:aUid,orderId:a.order.id,vip:fakeVip});
    const repeat=await deliverVerifiedOrderV2({ledger,userId:aUid,orderId:a.order.id,vip:fakeVip});
    const grants=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_e2e_fake_vip WHERE uid=?",aUid).toArray()[0]?.n||0);
    const checks=[
      {name:"fake_provider_200200_verified",passed:verifyA.ok===true&&verifyA.verified===true},
      {name:"cross_player_replay_blocked",passed:duplicate.reason==="duplicate_transfer"},
      {name:"provider_200000_rejected",passed:unverified.reason==="provider_or_image_rejected"},
      {name:"crash_after_grant_recovered",passed:first.verifiedButNotFulfilled===true&&recovered.fulfilled===true},
      {name:"vip_mock_granted_once",passed:grants===1&&recovered.alreadyApplied===true},
      {name:"repeat_claim_idempotent",passed:repeat.alreadyFulfilled===true&&grantCalls===3}
    ];
    const passed=checks.every(x=>x.passed);
    this.ctx.storage.sql.exec("INSERT INTO v2_e2e_mock_history(id,owner,created_at,passed) VALUES(?,?,?,?)",runId,uid,now,passed?1:0);
    return {ok:passed,stored:true,checks,simulation:true,externalProviderCalled:false,realVipGranted:false};
  }
  v2E2EMockHistory({uid}){
    this.initV2E2EMock();
    const rows=this.ctx.storage.sql.exec("SELECT created_at,passed FROM v2_e2e_mock_history WHERE owner=? ORDER BY created_at DESC LIMIT 6",uid).toArray();
    return {count:Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM v2_e2e_mock_history WHERE owner=?",uid).toArray()[0]?.n||0),
      entries:rows.map(x=>({at:x.created_at,passed:x.passed===1}))};
  }
  // Separate buyer-facing PREVIEW ledger. No provider, real QR, VIP, or Inventory calls.
  // Isolated buyer preview, never the real payment ledger.
  buyerPreviewV2(){return new PaymentV2BuyerPreviewLedger(this.ctx.storage);}
  createBuyerPreviewV2(input){return this.buyerPreviewV2().create(input);}
  listBuyerPreviewV2(input){return this.buyerPreviewV2().list(input);}
  simulateBuyerPreviewV2(input){return this.buyerPreviewV2().simulate(input);}
  // Prepared live V2 ledger is NEVER the historical payment or the fake preview instance.
  getPricesV2(){return currentPrices(this.ctx.storage.kv.get('admin:prices:v1'));}
  setPricesV2({prices,actor}){
    let checked;try{checked=checkedPrices(prices)}catch{return {ok:false,reason:'invalid_prices'}}
    if(typeof actor!=='string'||actor.length>254)return {ok:false,reason:'invalid_actor'};
    const old=this.getPricesV2();
    this.ctx.storage.kv.put('admin:prices:v1',checked);
    const log=this.ctx.storage.kv.get('admin:prices:audit')||[];
    this.ctx.storage.kv.put('admin:prices:audit',[{at:Date.now(),actor,old,prices:checked},...log].slice(0,50));
    return {ok:true,prices:checked};
  }
  priceAuditsV2(){return this.ctx.storage.kv.get('admin:prices:audit')||[];}
  paidV2(){return new PaymentV2LiveCoordinator(this.ctx.storage,this.env);}
  v2Vip(){return this.env.VIP.get(this.env.VIP.idFromName('vip-memberships-v1'));}
  v2Items(){return this.env.ITEMS.get(this.env.ITEMS.idFromName('inventory-v1'));}
  async paidV2Create({owner,sku,uuid}){
    const prices=this.getPricesV2();
    return this.paidV2().create({owner,sku,uuid,vip:this.v2Vip(),amountBaht:prices[sku]});
  }
  paidV2Get({owner,id}){return this.paidV2().get({owner,id});}
  paidV2Recent({owner}){return this.paidV2().recent({owner});}
  paidV2Qr({owner,id}){return this.paidV2().qrPayload({owner,id});}
  async paidV2Verify({owner,id,bytes}){
    return this.paidV2().verify({owner,id,bytes,vip:this.v2Vip(),inventory:this.v2Items()});
  }
  async paidV2Reconcile({owner,id}){
    return this.paidV2().reconcile({owner,id,vip:this.v2Vip(),inventory:this.v2Items()});
  }
  get(id,uid){
    const rows=this.ctx.storage.sql.exec('SELECT * FROM orders WHERE id=? AND uid=?',id,uid).toArray();
    return rows[0]||null;
  }
  hasPreviousPaid(uid){
    if(typeof uid!=='string'||!uid)return true;
    const row=this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS total FROM orders WHERE uid=? AND status IN ('verified','fulfilled')",uid
    ).toArray()[0];
    return Number(row?.total||0)>0;
  }
  getRecent(uid){
    if(typeof uid!=='string'||!uid)return null;
    // Read-only recovery for the signed-in buyer; never return other users' orders.
    const cutoff=Date.now()-7*86_400_000;
    return this.ctx.storage.sql.exec(
      "SELECT * FROM orders WHERE uid=? AND created_at>=? AND status IN ('pending','verifying','verified','fulfilled') ORDER BY CASE WHEN status='verified' THEN 0 WHEN status='verifying' THEN 1 WHEN status='pending' THEN 2 ELSE 3 END, created_at DESC LIMIT 1",
      uid,cutoff
    ).toArray()[0]||null;
  }
  async create({id,uid,sku}){
    const p=PRODUCTS[sku];if(!p||!uid||!/^order-[a-f0-9-]{36}$/.test(id))return {ok:false,reason:'invalid_order'};
    const now=Date.now(),rateKey=`rate:${uid}`;
    let rate=this.ctx.storage.kv.get(rateKey)||{at:now,count:0};
    if(now-rate.at>3_600_000)rate={at:now,count:0};
    if(rate.count>=8)return {ok:false,reason:'rate_limited'};
    const existing=this.ctx.storage.sql.exec("SELECT * FROM orders WHERE uid=? AND sku=? AND status IN ('pending','verifying','verified') AND expires_at>? ORDER BY created_at DESC LIMIT 1",uid,sku,now).toArray()[0];
    if(existing)return {ok:true,order:existing,reused:true};
    this.ctx.storage.sql.exec('INSERT INTO orders (id,uid,sku,amount,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?)',id,uid,sku,p.amount,now,now+ORDER_LIFETIME_MS,'pending');
    rate.count++;this.ctx.storage.kv.put(rateKey,rate);
    return {ok:true,order:this.get(id,uid)};
  }
  // Cancel a newly created VIP order if all 100 seats are occupied. A cancelled
  // order is never eligible for verification and will not block future checkout.
  cancelPending({id,uid}){
    const order=this.get(id,uid);
    if(!order||order.status!=='pending')return {ok:false};
    this.ctx.storage.sql.exec("UPDATE orders SET status='cancelled',lock_until=0 WHERE id=? AND uid=? AND status='pending'",id,uid);
    return {ok:true};
  }
  takeVerification({id,uid}){
    const order=this.get(id,uid),now=Date.now();
    if(!order)return {ok:false,reason:'missing_order'};
    if(order.status==='verified'||order.status==='fulfilled')return {ok:true,alreadyPaid:true,order};
    if(order.created_at+RECEIPT_RECOVERY_MS<=now)return {ok:false,reason:'verification_recovery_expired'};
    if(order.status==='verifying'&&order.lock_until>now)return {ok:false,reason:'verification_in_progress'};
    this.ctx.storage.sql.exec("UPDATE orders SET status='verifying',lock_until=? WHERE id=?",now+35_000,id);
    return {ok:true,order:this.get(id,uid)};
  }
  unlock({id,uid}){
    this.ctx.storage.sql.exec("UPDATE orders SET status='pending',lock_until=0 WHERE id=? AND uid=? AND status='verifying'",id,uid);
  }
  recordVerified({id,uid,hash}){
    const order=this.get(id,uid);
    if(!order||!hash||hash.length!==64)return {ok:false,reason:'invalid_order'};
    if(order.status==='fulfilled'||order.status==='verified')return {ok:order.tx_hash===hash,reason:'different_slip'};
    if(order.status!=='verifying'||Date.now()>order.created_at+RECEIPT_RECOVERY_MS)return {ok:false,reason:'verification_expired'};
    // A single SQL transaction prevents using the same verified bank transfer for any other order.
    let output;
    this.ctx.storage.transactionSync(()=>{
      const previous=this.ctx.storage.sql.exec('SELECT order_id FROM transfers WHERE fingerprint=?',hash).toArray()[0];
      if(previous&&previous.order_id!==id){output={ok:false,reason:'duplicate_transfer'};return;}
      if(!previous)this.ctx.storage.sql.exec('INSERT INTO transfers (fingerprint,order_id) VALUES (?,?)',hash,id);
      this.ctx.storage.sql.exec("UPDATE orders SET status='verified',tx_hash=?,lock_until=0 WHERE id=? AND uid=?",hash,id,uid);
      output={ok:true};
    });
    return output;
  }
  markFulfilled({id,uid}){
    const order=this.get(id,uid);
    if(!order)return {ok:false};
    if(order.status==='fulfilled')return {ok:true,alreadyApplied:true};
    if(order.status!=='verified')return {ok:false};
    this.ctx.storage.sql.exec("UPDATE orders SET status='fulfilled',fulfilled_at=? WHERE id=? AND uid=?",Date.now(),id,uid);
    return {ok:true};
  }
}
export class Inventory extends DurableObject {
  // A nickname belongs to the verified Firebase UID and persists across devices.
  async getProfile(uid){
    if(typeof uid!=='string'||!uid)return {name:null};
    return this.ctx.storage.kv.get(`profile:${uid}`)||{name:null};
  }
  async setProfile({uid,name}){
    if(typeof uid!=='string'||!uid||typeof name!=='string')return {ok:false,reason:'invalid_profile'};
    const clean=name.trim().normalize('NFC');
    if(!clean||clean.length>18||/[<>\x00-\x1f\x7f]/.test(clean))return {ok:false,reason:'invalid_name'};
    const profile={name:clean,updatedAt:Date.now()};
    this.ctx.storage.kv.put(`profile:${uid}`,profile);
    return {ok:true,profile};
  }
  async getItems(uid){
    const all=this.ctx.storage.kv.get(`inventory:${uid}`)||{};
    return {win2:all.win2>Date.now()?all.win2:0,shield:all.shield>Date.now()?all.shield:0};
  }
  async grant({uid,sku,transactionId}){
    if(!uid||!['win2','shield'].includes(sku)||!transactionId)return {ok:false};
    const previous=this.ctx.storage.kv.get(`inventory:receipt:${transactionId}`);
    if(previous)return previous.uid===uid&&previous.sku===sku?
      {ok:true,alreadyApplied:true,expiresAt:previous.expiresAt}:{ok:false,reason:'duplicate_transaction'};
    const all=this.ctx.storage.kv.get(`inventory:${uid}`)||{};
    const expiry=Math.max(Date.now(),all[sku]||0)+86_400_000;
    all[sku]=expiry;
    this.ctx.storage.kv.put(`inventory:${uid}`,all);
    this.ctx.storage.kv.put(`inventory:receipt:${transactionId}`,{uid,sku,expiresAt:expiry});
    return {ok:true,expiresAt:expiry};
  }
}
