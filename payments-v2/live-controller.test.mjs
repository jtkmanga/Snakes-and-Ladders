import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PaymentV2LiveCoordinator} from './live-controller.mjs';
const makeStorage=()=>{
 const db=new DatabaseSync(':memory:');
 return {db,storage:{
  sql:{exec(q,...args){const s=db.prepare(q);if(/^\s*SELECT/i.test(q)){const rows=s.all(...args);return {toArray:()=>rows};}s.run(...args);return {toArray:()=>[]}}},
  transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}
 }};
};
const env={PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'canary',
 PAYMENT_V2_OWNER_CANARY:'explicitly_approved',
 ADMIN_EMAIL:'admin@company.test',MERCHANT_ACCOUNT_TYPE:'02004',
 MERCHANT_ACCOUNT_NUMBER:'000000000000000',
 SLIP2GO_V2_SECRET:'dummy_key_only_test'};
const owner={id:'playerA',email:'admin@company.test'};
test('live controller is fail-closed even with all canary flags set until Stage 5',async()=>{
 const {storage,db}=makeStorage(),coordinator=new PaymentV2LiveCoordinator(storage,env);
 let vipCalls=0;
 const vip={reserveForCheckout:async()=>{vipCalls++;throw Error('unexpected real VIP call')},
  activateAfterVerifiedPayment:async()=>{vipCalls++;throw Error('unexpected real VIP call')}};
 const inv={grant:async()=>{throw Error('unexpected real Inventory grant')}};
 const id='payv2-00000000-0000-4000-8000-000000000001';
 const values=[
  await coordinator.create({owner,sku:'vip',uuid:'00000000-0000-4000-8000-000000000001',vip}),
  coordinator.get({owner,id}),
  coordinator.recent({owner}),
  coordinator.qrPayload({owner,id}),
  await coordinator.verify({owner,id,bytes:new Uint8Array(16),vip,inventory:inv}),
  await coordinator.reconcile({owner,id,vip,inventory:inv})
 ];
 for(const value of values){assert.equal(value.ok,false);assert.equal(value.reason,'real_transfer_test_pending')}
 assert.equal(vipCalls,0);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_paid_orders').get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,0);
});


const samplePng=()=>new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0]);
const allowed=()=>({ok:true});
const dummyReference='FAKEBANKREF0123456789';
function fakeProvider(amount=100,reference=dummyReference){
 return async (url,options)=>{
  assert.equal(url,'https://connect.slip2go.com/api/verify-slip/qr-image/info');
  assert.equal(options.method,'POST');
  assert.equal(options.headers.Authorization,'Bearer dummy_key_only_test');
  const checks=JSON.parse(options.body.get('payload'));
  assert.equal(checks.checkDuplicate,true);
  assert.equal(checks.checkReceiver[0].accountType,'02004');
  assert.equal(checks.checkAmount.type,'eq');
  return {status:200,ok:true,json:async()=>({
    code:'200200',
    data:{amount,transRef:reference,dateTime:new Date().toISOString(),sender:{bank:{id:'004'}}}
  })};
 };
}
test('entire real pipeline can be exercised OFFLINE with fake provider and fake VIP, never money',async()=>{
 const {storage,db}=makeStorage();
 let applied=0,reserved=0,calls=0;
 const vip={
  reserveForCheckout:async()=>{reserved++;return {ok:true}},
  activateAfterVerifiedPayment:async()=>{applied++;return {ok:true,expiresAt:Date.now()+2592000000}}
 };
 const controller=new PaymentV2LiveCoordinator(storage,env,{
  authorize:allowed,
  fetchFn:async (...args)=>{calls++;return fakeProvider()(...args)}
 });
 const id='payv2-00000000-0000-4000-8000-000000000001';
 const created=await controller.create({owner,sku:'vip',uuid:'00000000-0000-4000-8000-000000000001',vip});
 assert.equal(created.ok,true);
 assert.equal(created.order.amountBaht,100);
 assert.equal(reserved,1);
 const qr=controller.qrPayload({owner,id});
 assert.equal(qr.ok,true);
 assert.equal(typeof qr.payload,'string');
 assert.ok(qr.payload.includes('A000000677010111'));
 const result=await controller.verify({owner,id,bytes:samplePng(),vip,inventory:{}});
 assert.equal(result.ok,true);
 assert.equal(result.order.status,'fulfilled');
 assert.equal(applied,1);
 assert.equal(calls,1);
 assert.equal(controller.get({owner,id}).order.status,'fulfilled');
 const repeat=await controller.verify({owner,id,bytes:samplePng(),vip,inventory:{}});
 assert.equal(repeat.ok,true);
 assert.equal(repeat.alreadyFulfilled,true);
 assert.equal(applied,1);
 assert.equal(calls,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_delivery_outbox WHERE state=\'complete\'').get().n,1);
 assert.equal(controller.recent({owner}).orders.length,1);
});
test('wrong amount cannot lead to VIP activation; cross-account replay cannot claim same transfer',async()=>{
 const {storage}=makeStorage();
 let grants=0;
 const vip={reserveForCheckout:async()=>({ok:true}),
  activateAfterVerifiedPayment:async()=>{grants++;return {ok:true}}};
 const wrong=new PaymentV2LiveCoordinator(storage,env,{authorize:allowed,fetchFn:fakeProvider(999)});
 const uid='payv2-00000000-0000-4000-8000-000000000002';
 await wrong.create({owner,sku:'vip',uuid:'00000000-0000-4000-8000-000000000002',vip});
 const bad=await wrong.verify({owner,id:uid,bytes:samplePng(),vip,inventory:{}});
 assert.equal(bad.ok,false);
 assert.equal(grants,0);
 const good=new PaymentV2LiveCoordinator(storage,env,{authorize:allowed,fetchFn:fakeProvider(100)});
 const aCreated=await good.create({owner,sku:'vip',uuid:'00000000-0000-4000-8000-000000000003',vip});
 assert.equal(aCreated.ok,true);
 // The prior declined slip leaves the original pending order reusable by design.
 const aId=aCreated.order.id;
 const bId='payv2-00000000-0000-4000-8000-000000000004';
 const ownerB={id:'playerB',email:owner.email};
 await good.create({owner:ownerB,sku:'vip',uuid:'00000000-0000-4000-8000-000000000004',vip});
 assert.equal((await good.verify({owner,id:aId,bytes:samplePng(),vip,inventory:{}})).ok,true);
 const duplicate=await good.verify({owner:ownerB,id:bId,bytes:samplePng(),vip,inventory:{}});
 assert.equal(duplicate.ok,false);
 assert.equal(duplicate.reason,'duplicate_transfer');
 assert.equal(grants,1);
});
test('100-person VIP rejection cancels unpaid order before QR can be fetched',async()=>{
 const {storage}=makeStorage();
 const c=new PaymentV2LiveCoordinator(storage,env,{authorize:allowed});
 const vip={reserveForCheckout:async()=>({ok:false,reason:'vip_full'})};
 const uuid='00000000-0000-4000-8000-000000000005';
 const out=await c.create({owner,sku:'vip',uuid,vip});
 assert.equal(out.ok,false);assert.equal(out.reason,'vip_full');
 assert.equal(c.qrPayload({owner,id:'payv2-'+uuid}).reason,'not_payable');
 assert.equal(c.get({owner,id:'payv2-'+uuid}).order.status,'cancelled');
});
