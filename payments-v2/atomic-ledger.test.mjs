import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PaymentV2AtomicLedger} from './atomic-ledger.mjs';

// A real in-memory SQLite DB with an adapter matching Cloudflare SQL storage.
// Unlike an in-memory Map, this exercises actual UNIQUE constraints and ROLLBACK.
function createHarness(){
  const db=new DatabaseSync(':memory:');
  const sql={exec(query,...args){
    const stmt=db.prepare(query);
    if(/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(query)){
      const rows=stmt.all(...args);
      return {toArray:()=>rows};
    }
    stmt.run(...args);
    return {toArray:()=>[]};
  }};
  const storage={sql,transactionSync(fn){
    db.exec('BEGIN IMMEDIATE');
    try{const result=fn();db.exec('COMMIT');return result;}
    catch(err){db.exec('ROLLBACK');throw err;}
  }};
  let now=Date.parse('2026-11-08T10:30:00Z');
  const ledger=new PaymentV2AtomicLedger(storage,{clock:()=>now});
  return {db,storage,ledger,get now(){return now},setNow(n){now=n}};
}
const user1='firebase-user-12345',user2='firebase-user-67890';
const orderUuids=['11111111-2222-4333-8444-555555555555','11111111-2222-4333-8444-555555555556'];
const attempt1='22222222-3333-4333-8444-666666666666';
const attempt2='22222222-3333-4333-8444-666666666667';
const receipt=(order,hash='a'.repeat(64))=>({
  verifiedBy:'provider_200200',orderId:order.id,amountBaht:order.amount,
  transferredAt:order.created_at+15000,fingerprint:hash,entitlementGranted:false
});
const start=(l,uid,sku,uuid,attemptId=attempt1)=>{
  const created=l.createPending({uid,sku,uuid});
  assert.equal(created.ok,true);
  const begun=l.beginVerification({id:created.order.id,uid,attemptId});
  assert.equal(begun.ok,true);
  return created.order;
};
const claim=(l,id,uid,attemptId,event)=>l.providerVerified({id,uid,attemptId,event});

test('schema is separate, creates server-priced orders, and does not touch legacy orders',()=>{
  const {db,ledger}=createHarness();
  const saved=ledger.createPending({uid:user1,sku:'vip',uuid:orderUuids[0]});
  assert.equal(saved.ok,true);
  assert.equal(saved.order.amount,100);
  assert.equal(saved.order.status,'pending');
  assert.equal(ledger.createPending({uid:user1,sku:'vip',uuid:orderUuids[1]}).reused,true);
  assert.equal(ledger.createPending({uid:user1,sku:'fake',uuid:orderUuids[1]}).ok,false);
  assert.equal(ledger.getOrder({id:saved.order.id,uid:user2}),null);
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(x=>x.name);
  assert.ok(names.includes('v2_paid_orders')&&names.includes('v2_unique_transfers')&&names.includes('v2_delivery_outbox'));
  assert.ok(!names.includes('orders')&&!names.includes('transfers'));
});
test('one provider-verified bank transfer can be claimed by only one player/order',()=>{
  const {ledger,db,storage}=createHarness();
  const a=start(ledger,user1,'shield',orderUuids[0]);
  const b=start(ledger,user2,'win2',orderUuids[1]);
  const first=claim(ledger,a.id,user1,attempt1,receipt(a));
  assert.deepEqual({ok:first.ok,verified:first.verified},{ok:true,verified:true});
  const second=claim(ledger,b.id,user2,attempt1,receipt(b));
  assert.equal(second.ok,false);
  assert.equal(second.reason,'duplicate_transfer');
  assert.equal(ledger.getOrder({id:b.id,uid:user2}).status,'verifying');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,1);
  // Retains results across object re-instantiation/deployment-like restart.
  const restarted=new PaymentV2AtomicLedger(storage);
  assert.equal(restarted.getOrder({id:a.id,uid:user1}).status,'verified');
  assert.equal(restarted.getOrder({id:b.id,uid:user2}).status,'verifying');
});
test('same order + same fingerprint is idempotent; different fingerprint is denied',()=>{
  const {ledger,db}=createHarness();
  const a=start(ledger,user1,'vip',orderUuids[0]);
  assert.equal(claim(ledger,a.id,user1,attempt1,receipt(a)).ok,true);
  assert.equal(claim(ledger,a.id,user1,attempt1,receipt(a)).idempotent,true);
  assert.equal(claim(ledger,a.id,user1,attempt1,receipt(a,'b'.repeat(64))).reason,'different_transfer');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_delivery_outbox').get().n,1);
});
test('rejects forged, stale, mismatched and expired verification without storing transfer',()=>{
  const {ledger,db,setNow,now}=createHarness();
  const a=start(ledger,user1,'shield',orderUuids[0]);
  assert.equal(claim(ledger,a.id,user1,attempt1,{...receipt(a),verifiedBy:'provider_200000'}).reason,'untrusted_event');
  assert.equal(claim(ledger,a.id,user1,attempt2,receipt(a)).reason,'stale_verification');
  assert.equal(claim(ledger,a.id,user1,attempt1,{...receipt(a),amountBaht:99}).reason,'amount_or_time_mismatch');
  assert.equal(claim(ledger,a.id,user1,attempt1,{...receipt(a),transferredAt:a.expires_at+61000}).reason,'amount_or_time_mismatch');
  assert.equal(claim(ledger,a.id,user1,attempt1,{...receipt(a),fingerprint:'INVALID'}).reason,'untrusted_event');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,0);
  setNow(now+86400000);
  assert.equal(claim(ledger,a.id,user1,attempt1,receipt(a)).reason,'stale_verification');
});
test('verification lease rejects parallel worker calls, and old attempt cannot commit after retry',()=>{
  const x=createHarness();
  const o=start(x.ledger,user1,'shield',orderUuids[0]);
  assert.equal(x.ledger.beginVerification({id:o.id,uid:user1,attemptId:attempt2}).reason,'verification_in_progress');
  x.setNow(x.now+46000);
  assert.equal(x.ledger.beginVerification({id:o.id,uid:user1,attemptId:attempt2}).ok,true);
  assert.equal(claim(x.ledger,o.id,user1,attempt1,receipt(o)).reason,'stale_verification');
  assert.equal(claim(x.ledger,o.id,user1,attempt2,receipt(o)).ok,true);
});
test('persistent outbox claim, crash-retry, stale attempt fencing, and at-most-once completion',()=>{
  const x=createHarness(),{ledger,db}=x;
  const o=start(ledger,user1,'vip',orderUuids[0]);
  assert.equal(claim(ledger,o.id,user1,attempt1,receipt(o)).ok,true);
  const one=ledger.claimDelivery({id:o.id,uid:user1});
  assert.equal(one.ok,true);
  assert.equal(one.attempt,1);
  assert.equal(one.deliveryKey,'payv2:'+o.id);
  assert.equal(ledger.claimDelivery({id:o.id,uid:user1}).reason,'in_progress');
  x.setNow(x.now+46000);
  const two=ledger.claimDelivery({id:o.id,uid:user1});
  assert.equal(two.attempt,2);
  assert.equal(two.deliveryKey,one.deliveryKey);
  assert.equal(ledger.markFulfilled({id:o.id,uid:user1,attempt:1}).reason,'stale_delivery_attempt');
  assert.equal(ledger.markFulfilled({id:o.id,uid:user1,attempt:2}).fulfilled,true);
  assert.equal(ledger.markFulfilled({id:o.id,uid:user1,attempt:2}).alreadyFulfilled,true);
  assert.equal(ledger.claimDelivery({id:o.id,uid:user1}).alreadyFulfilled,true);
  assert.equal(db.prepare("SELECT state FROM v2_delivery_outbox WHERE order_id=?").get(o.id).state,'complete');
});
test('releaseDelivery after transient downstream error retains unique claim and safely retries',()=>{
  const x=createHarness(),{ledger,db}=x;
  const o=start(ledger,user1,'shield',orderUuids[0]);
  claim(ledger,o.id,user1,attempt1,receipt(o));
  const first=ledger.claimDelivery({id:o.id,uid:user1});
  assert.equal(ledger.releaseDelivery({id:o.id,uid:user1,attempt:first.attempt}).ok,true);
  assert.equal(ledger.getOrder({id:o.id,uid:user1}).status,'verified');
  const second=ledger.claimDelivery({id:o.id,uid:user1});
  assert.equal(second.attempt,2);
  assert.equal(second.deliveryKey,first.deliveryKey);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,1);
});
test('write failure rolls back transfer claim, state change and outbox together',()=>{
  const x=createHarness(),{ledger,db,storage}=x;
  const o=start(ledger,user1,'shield',orderUuids[0]);
  // Force the outbox INSERT to fail after transfer claim + order update.
  db.exec('DROP TABLE v2_delivery_outbox');
  assert.throws(()=>claim(ledger,o.id,user1,attempt1,receipt(o)));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,0);
  assert.equal(ledger.getOrder({id:o.id,uid:user1}).status,'verifying');
  // Re-instantiation recreates missing outbox and allows recovery.
  const recovered=new PaymentV2AtomicLedger(storage,{clock:()=>x.now});
  assert.equal(claim(recovered,o.id,user1,attempt1,receipt(o)).ok,true);
});
test('not one test-only record can be inserted or marked fulfilled via this ledger without provider event',()=>{
  const {ledger,db}=createHarness();
  const order=ledger.createPending({uid:user1,sku:'vip',uuid:orderUuids[0]}).order;
  assert.equal(ledger.claimDelivery({id:order.id,uid:user1}).reason,'not_verified');
  assert.equal(ledger.markFulfilled({id:order.id,uid:user1,attempt:1}).reason,'stale_delivery_attempt');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_delivery_outbox').get().n,0);
});
