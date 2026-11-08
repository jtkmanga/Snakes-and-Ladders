// Payment V2: atomic SQLite Durable Object ledger. NOT wired into public checkout.
// Use ONE dedicated global DO instance for ALL payments. No provider calls or
// entitlement grants happen in this class.
// Never call providerVerified() directly with browser JSON; only a trusted server
// adapter may construct the verified event after Slip2Go code 200200.
import {PRODUCTS_V2,createPendingOrder} from './core.mjs';
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const read=(s,q,...args)=>s.sql.exec(q,...args).toArray()[0]||null;
const validUid=u=>typeof u==='string'&&/^[A-Za-z0-9_:-]{4,128}$/.test(u);
const RECOVERY=86400000;
export class PaymentV2AtomicLedger {
  constructor(storage,{clock=()=>Date.now()}={}){
    if(!storage?.sql||typeof storage.transactionSync!=='function')throw Error('sqlite_required');
    this.s=storage;this.clock=clock;this.initialize();
  }
  initialize(){
    this.s.sql.exec("CREATE TABLE IF NOT EXISTS v2_paid_orders (id TEXT PRIMARY KEY,uid TEXT NOT NULL,sku TEXT NOT NULL,amount INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','verifying','verified','fulfilling','fulfilled','cancelled')),verify_attempt TEXT,verify_lease_until INTEGER NOT NULL DEFAULT 0,tx_hash TEXT UNIQUE,fulfilled_at INTEGER)");
    this.s.sql.exec("CREATE TABLE IF NOT EXISTS v2_unique_transfers (hash TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE,uid TEXT NOT NULL)");
    this.s.sql.exec("CREATE TABLE IF NOT EXISTS v2_delivery_outbox (order_id TEXT PRIMARY KEY,delivery_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('pending','claimed','complete')),attempt INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,completed_at INTEGER)");
    this.s.sql.exec("CREATE INDEX IF NOT EXISTS idx_v2_paid_uid_date ON v2_paid_orders(uid,created_at)");
  }
  getOrder({id,uid}){
    if(!validUid(uid)||typeof id!=='string')return null;
    return read(this.s,'SELECT * FROM v2_paid_orders WHERE id=? AND uid=?',id,uid);
  }
  createPending({uid,sku,uuid}){
    if(!validUid(uid)||!Object.hasOwn(PRODUCTS_V2,sku)||!UUID.test(String(uuid||'')))
      return {ok:false,reason:'invalid_order'};
    const now=this.clock();
    return this.s.transactionSync(()=>{
      const old=read(this.s,"SELECT * FROM v2_paid_orders WHERE uid=? AND sku=? AND expires_at>? AND status IN ('pending','verifying','verified','fulfilling') ORDER BY created_at DESC LIMIT 1",uid,sku,now);
      if(old)return {ok:true,reused:true,order:old};
      const n=read(this.s,'SELECT COUNT(*) AS n FROM v2_paid_orders WHERE uid=? AND created_at>?',uid,now-RECOVERY);
      if(Number(n?.n||0)>=12)return {ok:false,reason:'rate_limited'};
      const input=createPendingOrder({uid,sku,uuid,now});
      this.s.sql.exec("INSERT INTO v2_paid_orders(id,uid,sku,amount,created_at,expires_at,status) VALUES(?,?,?,?,?,?,'pending')",input.id,uid,sku,input.amountBaht,input.createdAt,input.expiresAt);
      return {ok:true,reused:false,order:this.getOrder({id:input.id,uid})};
    });
  }
  // Cancel an unpaid order if VIP capacity cannot be reserved.
  cancelPending({id,uid}){
    if(!validUid(uid)||typeof id!=="string")return {ok:false,reason:"invalid_order"};
    return this.s.transactionSync(()=>{
      const row=this.getOrder({id,uid});
      if(!row)return {ok:false,reason:"missing_order"};
      if(row.status==="cancelled")return {ok:true,alreadyCancelled:true};
      if(row.status!=="pending")return {ok:false,reason:"already_processing"};
      this.s.sql.exec("UPDATE v2_paid_orders SET status='cancelled' WHERE id=? AND uid=? AND status='pending'",id,uid);
      return {ok:true,cancelled:true};
    });
  }
  beginVerification({id,uid,attemptId}){
    if(!validUid(uid)||!UUID.test(String(attemptId||'')))return {ok:false,reason:'invalid_attempt'};
    const now=this.clock();
    return this.s.transactionSync(()=>{
      const o=this.getOrder({id,uid});
      if(!o)return {ok:false,reason:'missing_order'};
      if(['verified','fulfilling','fulfilled'].includes(o.status))return {ok:true,alreadyVerified:true};
      if(o.status==='cancelled'||now>=o.created_at+RECOVERY)return {ok:false,reason:'recovery_expired'};
      if(o.status==='verifying'&&o.verify_lease_until>now)return {ok:false,reason:'verification_in_progress'};
      this.s.sql.exec("UPDATE v2_paid_orders SET status='verifying',verify_attempt=?,verify_lease_until=? WHERE id=? AND uid=? AND status IN ('pending','verifying')",attemptId,now+45000,id,uid);
      return {ok:true,attemptId,order:this.getOrder({id,uid})};
    });
  }
  releaseVerification({id,uid,attemptId}){
    return this.s.transactionSync(()=>{
      const o=this.getOrder({id,uid});
      if(!o||o.status!=='verifying'||o.verify_attempt!==attemptId)return {ok:false,reason:'stale_attempt'};
      this.s.sql.exec("UPDATE v2_paid_orders SET status='pending',verify_attempt=NULL,verify_lease_until=0 WHERE id=? AND uid=?",id,uid);
      return {ok:true};
    });
  }
  // ONLY trusted server code may call this with a result from verifySlipImageServer.
  providerVerified({id,uid,attemptId,event}){
    if(!validUid(uid)||!UUID.test(String(attemptId||''))||event?.verifiedBy!=='provider_200200'||
       event.orderId!==id||!HASH.test(String(event.fingerprint||''))||
       !Number.isSafeInteger(event.amountBaht)||!Number.isSafeInteger(event.transferredAt))
      return {ok:false,reason:'untrusted_event'};
    const now=this.clock();
    return this.s.transactionSync(()=>{
      const o=this.getOrder({id,uid});
      if(!o)return {ok:false,reason:'missing_order'};
      if(['verified','fulfilling','fulfilled'].includes(o.status))
        return o.tx_hash===event.fingerprint?{ok:true,idempotent:true}:{ok:false,reason:'different_transfer'};
      if(o.status!=='verifying'||o.verify_attempt!==attemptId||now>=o.created_at+RECOVERY)
        return {ok:false,reason:'stale_verification'};
      if(o.amount!==event.amountBaht||event.transferredAt<o.created_at-120000||
         event.transferredAt>o.expires_at+60000||event.transferredAt>now+60000)
        return {ok:false,reason:'amount_or_time_mismatch'};
      const previous=read(this.s,'SELECT order_id FROM v2_unique_transfers WHERE hash=?',event.fingerprint);
      if(previous)return {ok:false,reason:previous.order_id!==id?'duplicate_transfer':'inconsistent_order'};
      // Unique transfer claim + order state change + outbox must all commit together.
      this.s.sql.exec('INSERT INTO v2_unique_transfers(hash,order_id,uid) VALUES(?,?,?)',event.fingerprint,id,uid);
      this.s.sql.exec("UPDATE v2_paid_orders SET status='verified',verify_attempt=NULL,verify_lease_until=0,tx_hash=? WHERE id=? AND uid=? AND status='verifying'",event.fingerprint,id,uid);
      this.s.sql.exec("INSERT INTO v2_delivery_outbox(order_id,delivery_key,state) VALUES(?,?,'pending')",id,'payv2:'+id);
      return {ok:true,verified:true};
    });
  }
  // A lease ensures only one worker delivers; retry after a crash uses the SAME
  // deliveryKey, which MUST be deduplicated by the target VIP/Inventory DO.
  claimDelivery({id,uid}){
    const now=this.clock();
    return this.s.transactionSync(()=>{
      const o=this.getOrder({id,uid});
      if(!o)return {ok:false,reason:'missing_order'};
      if(o.status==='fulfilled')return {ok:true,alreadyFulfilled:true};
      const out=read(this.s,'SELECT * FROM v2_delivery_outbox WHERE order_id=?',id);
      if(!out||!o.tx_hash)return {ok:false,reason:'not_verified'};
      if(o.status==='fulfilling'&&out.lease_until>now)return {ok:false,reason:'in_progress'};
      if(!['verified','fulfilling'].includes(o.status))return {ok:false,reason:'not_verified'};
      if(Number(out.attempt)>=8)return {ok:false,reason:'manual_review'};
      const attempt=Number(out.attempt)+1;
      this.s.sql.exec("UPDATE v2_delivery_outbox SET state='claimed',attempt=?,lease_until=? WHERE order_id=?",attempt,now+45000,id);
      this.s.sql.exec("UPDATE v2_paid_orders SET status='fulfilling' WHERE id=?",id);
      return {ok:true,attempt,deliveryKey:out.delivery_key,orderId:id,uid,sku:o.sku,transferHash:o.tx_hash};
    });
  }
  markFulfilled({id,uid,attempt}){
    const now=this.clock();
    return this.s.transactionSync(()=>{
      const o=this.getOrder({id,uid});
      if(!o)return {ok:false,reason:'missing_order'};
      if(o.status==='fulfilled')return {ok:true,alreadyFulfilled:true};
      const out=read(this.s,'SELECT * FROM v2_delivery_outbox WHERE order_id=?',id);
      if(o.status!=='fulfilling'||out?.state!=='claimed'||out.attempt!==attempt)
        return {ok:false,reason:'stale_delivery_attempt'};
      this.s.sql.exec("UPDATE v2_paid_orders SET status='fulfilled',fulfilled_at=? WHERE id=? AND uid=?",now,id,uid);
      this.s.sql.exec("UPDATE v2_delivery_outbox SET state='complete',lease_until=0,completed_at=? WHERE order_id=?",now,id);
      return {ok:true,fulfilled:true};
    });
  }
  releaseDelivery({id,uid,attempt}){
    return this.s.transactionSync(()=>{
      const o=this.getOrder({id,uid});
      const out=read(this.s,'SELECT * FROM v2_delivery_outbox WHERE order_id=?',id);
      if(!o||o.status!=='fulfilling'||out?.state!=='claimed'||out.attempt!==attempt)
        return {ok:false,reason:'stale_delivery_attempt'};
      this.s.sql.exec("UPDATE v2_paid_orders SET status='verified' WHERE id=? AND uid=?",id,uid);
      this.s.sql.exec("UPDATE v2_delivery_outbox SET state='pending',lease_until=0 WHERE order_id=?",id);
      return {ok:true};
    });
  }
}
