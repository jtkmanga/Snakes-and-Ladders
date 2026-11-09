import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PaymentV2AtomicLedger} from './atomic-ledger.mjs';
import {verifyOrderV2,deliverVerifiedOrderV2} from './server-coordinator.mjs';
const now=Date.parse('2026-11-08T10:45:00Z');
const uuid1='11111111-2222-4333-8444-555555555555';
const uuid2='11111111-2222-4333-8444-555555555556';
const attempt='22222222-3333-4333-8444-666666666666';
const uid1='firebase-player-12345',uid2='firebase-player-67890';
const env={PAYMENTS_ENABLED:'false',PAYMENT_ROLLOUT:'disabled',
 MERCHANT_ACCOUNT_TYPE:'02004',MERCHANT_ACCOUNT_NUMBER:'123456789012345',
 SLIP2GO_V2_SECRET:'UNIT-TEST-ONLY-SLIP2GO'};
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,1,2,3,4]);
const verified=(amount)=>({code:'200200',data:{amount,transRef:'MOCKBANK123456789',
 dateTime:new Date(now+10000).toISOString(),sender:{bank:{id:'004'}}}});
const provider=(response)=>async()=>({status:200,ok:true,json:async()=>response});
function harness(){
 const db=new DatabaseSync(':memory:');
 const storage={sql:{exec(q,...args){
  const st=db.prepare(q);
  if(/^\s*SELECT/i.test(q)){const rows=st.all(...args);return {toArray:()=>rows}}
  st.run(...args);return {toArray:()=>[]};
 }},transactionSync(fn){
  db.exec('BEGIN IMMEDIATE');
  try{const x=fn();db.exec('COMMIT');return x;}catch(e){db.exec('ROLLBACK');throw e;}
 }};
 let clock=now;
 const ledger=new PaymentV2AtomicLedger(storage,{clock:()=>clock});
 return {db,ledger,storage,setClock:x=>{clock=x}};
}
const create=(l,uid=uid1,sku='shield',uuid=uuid1)=>{
 const r=l.createPending({uid,sku,uuid});assert.equal(r.ok,true);return r.order;
};
const verify=(l,order,config={})=>verifyOrderV2({
 ledger:l,userId:order.uid,orderId:order.id,env,bytes:png,now:now+20000,
 uuid:()=>attempt,fetchFn:provider(verified(order.amount)),...config
});

test('server-only coordinator saves verified event and outbox without granting any rights',async()=>{
 const {ledger,db}=harness(),order=create(ledger);
 const result=await verify(ledger,order);
 assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(result.entitlementGranted,false);
 assert.equal(ledger.getOrder({id:order.id,uid:uid1}).status,'verified');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_delivery_outbox').get().n,1);
});
test('slip merely found (200000) cannot verify, create outbox, or unlock VIP',async()=>{
 const {ledger,db}=harness(),order=create(ledger);
 const result=await verify(ledger,order,{fetchFn:provider({...verified(10),code:'200000'})});
 assert.equal(result.ok,false);assert.equal(result.reason,'provider_or_image_rejected');
 assert.equal(ledger.getOrder({id:order.id,uid:uid1}).status,'pending');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_delivery_outbox').get().n,0);
});
test('wrong provider amount and incorrect E-Wallet account configuration fail closed',async()=>{
 const {ledger,db}=harness(),order=create(ledger);
 assert.equal((await verify(ledger,order,{fetchFn:provider(verified(100))})).ok,false);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,0);
 const bad=await verify(ledger,order,{env:{...env,MERCHANT_ACCOUNT_TYPE:'02001'},fetchFn:()=>{throw Error('must not call')}});
 assert.equal(bad.reason,'receiver_not_ready');
});
test('same provider receipt cannot pay for orders belonging to different players',async()=>{
 const {ledger,db}=harness(),first=create(ledger),second=create(ledger,uid2,'win2',uuid2);
 assert.equal((await verify(ledger,first)).ok,true);
 const retry=await verify(ledger,second,{fetchFn:provider(verified(20))});
 assert.equal(retry.ok,false);
 assert.equal(retry.reason,'duplicate_transfer');
 assert.equal(ledger.getOrder({id:second.id,uid:uid2}).status,'pending');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,1);
});
test('no service may grant a pending or unverified purchase',async()=>{
 const {ledger}=harness(),order=create(ledger);
 let calls=0;
 const inventory={grant:async()=>{calls++;return {ok:true}}};
 const result=await deliverVerifiedOrderV2({ledger,userId:uid1,orderId:order.id,inventory});
 assert.equal(result.ok,false);assert.equal(result.reason,'not_verified');assert.equal(calls,0);
});
test('inventory retry uses same stable idempotency key after crash, never doubles the item',async()=>{
 const {ledger}=harness(),order=create(ledger);
 assert.equal((await verify(ledger,order)).ok,true);
 const keys=new Map();
 let actualGrants=0;
 const inventory={grant:async({uid,sku,transactionId})=>{
  if(keys.has(transactionId))return {ok:true,alreadyApplied:true};
  actualGrants++;keys.set(transactionId,{uid,sku});return {ok:true,expiresAt:now+86400000};
 }};
 const realMark=ledger.markFulfilled.bind(ledger);
 let failOnce=true;
 ledger.markFulfilled=(args)=>{if(failOnce){failOnce=false;throw Error('worker_crash_after_grant')}return realMark(args);};
 const first=await deliverVerifiedOrderV2({ledger,userId:uid1,orderId:order.id,inventory});
 assert.equal(first.ok,false);assert.equal(first.verifiedButNotFulfilled,true);
 const second=await deliverVerifiedOrderV2({ledger,userId:uid1,orderId:order.id,inventory});
 assert.equal(second.ok,true);assert.equal(second.alreadyApplied,true);
 assert.equal(actualGrants,1);assert.equal(keys.size,1);
 assert.equal(ledger.getOrder({id:order.id,uid:uid1}).status,'fulfilled');
 assert.equal((await deliverVerifiedOrderV2({ledger,userId:uid1,orderId:order.id,inventory})).alreadyFulfilled,true);
});
test('VIP is not activated when 100-person capacity reservation fails',async()=>{
 const {ledger}=harness(),order=create(ledger,uid1,'vip');
 assert.equal((await verify(ledger,order)).ok,true);
 let granted=0;
 const vip={activateAfterVerifiedPayment:async()=>({ok:false,reason:'missing_or_expired_hold'}),
 reserveForCheckout:async()=>({ok:false,reason:'vip_full'})};
 const result=await deliverVerifiedOrderV2({ledger,userId:uid1,orderId:order.id,vip});
 assert.equal(result.ok,false);assert.equal(result.reason,'vip_full');
 assert.equal(result.verifiedButNotFulfilled,true);
 assert.equal(ledger.getOrder({id:order.id,uid:uid1}).status,'verified');
 assert.equal(granted,0);
});
test('VIP entitlement uses stable transaction id, prevents repeated 30-day extensions',async()=>{
 const {ledger}=harness(),order=create(ledger,uid1,'vip');
 assert.equal((await verify(ledger,order)).ok,true);
 const receipts=new Set();let extensions=0,reserved=false;
 const vip={
  reserveForCheckout:async()=>{reserved=true;return {ok:true}},
  activateAfterVerifiedPayment:async({userId,orderId,transactionId})=>{
   if(receipts.has(transactionId))return {ok:true,alreadyApplied:true,expiresAt:now+30*86400000};
   if(!reserved)return {ok:false,reason:'missing_or_expired_hold'};
   assert.equal(userId,uid1);assert.equal(orderId,order.id);
   assert.equal(transactionId,'payv2:'+order.id);
   receipts.add(transactionId);extensions++;return {ok:true,expiresAt:now+30*86400000};
  }
 };
 const one=await deliverVerifiedOrderV2({ledger,userId:uid1,orderId:order.id,vip});
 assert.equal(one.ok,true);assert.equal(extensions,1);
 const again=await deliverVerifiedOrderV2({ledger,userId:uid1,orderId:order.id,vip});
 assert.equal(again.alreadyFulfilled,true);assert.equal(extensions,1);
});
test('never call the provider while real payment flag is enabled in staged code',async()=>{
 const {ledger}=harness(),order=create(ledger);
 let called=false;
 const r=await verify(ledger,order,{env:{...env,PAYMENTS_ENABLED:'true'},
  fetchFn:async()=>{called=true;throw Error('bad')}} );
 assert.equal(r.ok,false);assert.equal(r.reason,'safe_mode_required');assert.equal(called,false);
});
