import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PaymentV2LiveCoordinator} from './live-controller.mjs';
const makeStorage=()=>{
 const db=new DatabaseSync(':memory:');
 return {db,storage:{
 sql:{exec(q,...args){const s=db.prepare(q);if(/^\s*SELECT/i.test(q)){const rows=s.all(...args);return {toArray:()=>rows};}s.run(...args);return {toArray:()=>[]}}},
 transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v}catch(e){db.exec('ROLLBACK');throw e}}
 }};
};
const env={PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'canary',
 PAYMENT_V2_OWNER_CANARY:'explicitly_approved',ADMIN_EMAIL:'admin@company.test',
 MERCHANT_ACCOUNT_TYPE:'02004',MERCHANT_ACCOUNT_NUMBER:'000000000000000',
 SLIP2GO_V2_SECRET:'dummy_key_only_test'};
const owner={id:'playerA',email:'admin@company.test'};
const userB={id:'playerB',email:'admin@company.test'};
const samplePng=()=>new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0]);
const fakeProvider=(amount=10,reference='FAKEBANKREF0123456789')=>async(url,options)=>{
 assert.equal(url,'https://connect.slip2go.com/api/verify-slip/qr-image/info');
 assert.equal(options.method,'POST');
 assert.equal(options.headers.Authorization,'Bearer dummy_key_only_test');
 const checks=JSON.parse(options.body.get('payload'));
 assert.equal(checks.checkDuplicate,true);
 assert.equal(checks.checkReceiver[0].accountType,'02004');
 assert.equal(checks.checkAmount.type,'eq');
 assert.equal(checks.checkAmount.amount,'10');
 return {status:200,ok:true,json:async()=>({
  code:'200200',data:{amount,transRef:reference,dateTime:new Date().toISOString(),sender:{bank:{id:'004'}}}
 })};
};
const id1='payv2-00000000-0000-4000-8000-000000000001';
const uuid1='00000000-0000-4000-8000-000000000001';

test('owner canary requires secret third flag and Google owner even if other flags are true',async()=>{
 const {storage,db}=makeStorage();
 const locked=new PaymentV2LiveCoordinator(storage,{...env,PAYMENT_V2_OWNER_CANARY:''});
 const forbidden=await locked.create({owner,sku:'shield',uuid:uuid1});
 assert.equal(forbidden.ok,false);assert.equal(forbidden.reason,'canary_not_approved');
 assert.equal(locked.qrPayload({owner,id:id1}).ok,false);
 assert.equal(locked.recent({owner}).ok,false);
 const open=new PaymentV2LiveCoordinator(storage,env);
 const other=await open.create({owner:{id:'playerB',email:'other@example.org'},sku:'shield',uuid:uuid1});
 assert.equal(other.ok,false);assert.equal(other.reason,'owner_only');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_paid_orders').get().n,0);
});

test('owner can create three real purchase types with correct server-side prices and payable QR',async()=>{
 const {storage}=makeStorage();
 const c=new PaymentV2LiveCoordinator(storage,env);
 const vip={reserveForCheckout:async()=>({ok:true})};
 for(const [sku,amount,uuid] of [
  ['shield',10,'00000000-0000-4000-8000-000000000001'],
  ['win2',20,'00000000-0000-4000-8000-000000000002'],
  ['vip',100,'00000000-0000-4000-8000-000000000003']]){
   const result=await c.create({owner,sku,uuid,vip});
   assert.equal(result.ok,true,sku);
   assert.equal(result.order.amountBaht,amount);
   assert.equal(result.order.status,'pending');
   const qr=c.qrPayload({owner,id:result.order.id});
   assert.equal(qr.ok,true,sku);
   assert.ok(qr.payload.includes('A000000677010111'));
   const other=c.get({owner:userB,id:result.order.id});
   assert.equal(other.ok,false);
 }
 const reused=await c.create({owner,sku:'shield',uuid:'00000000-0000-4000-8000-000000000004',vip});
 assert.equal(reused.reused,true);
 assert.equal(reused.order.id,id1);
});

test('fake provider approval -> one real-logic item grant, never duplicate (offline test only)',async()=>{
 const {storage,db}=makeStorage();
 let grants=0,providerCalls=0;
 const inventory={grant:async()=>{grants++;return{ok:true,expiresAt:Date.now()+86_400_000}}};
 const c=new PaymentV2LiveCoordinator(storage,env,{fetchFn:async(...args)=>{providerCalls++;return fakeProvider()(...args)}});
 assert.equal((await c.create({owner,sku:'shield',uuid:uuid1})).ok,true);
 const receipt=await c.verify({owner,id:id1,bytes:samplePng(),inventory});
 assert.equal(receipt.ok,true);assert.equal(receipt.order.status,'fulfilled');
 assert.equal(grants,1);assert.equal(providerCalls,1);
 const retry=await c.verify({owner,id:id1,bytes:samplePng(),inventory});
 assert.equal(retry.ok,true);assert.equal(retry.alreadyFulfilled,true);
 assert.equal(grants,1);assert.equal(providerCalls,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM v2_unique_transfers').get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM v2_delivery_outbox WHERE state='complete'").get().n,1);
 assert.equal(c.recent({owner}).orders.length,1);
 const another=await c.create({owner,sku:'shield',uuid:'00000000-0000-4000-8000-000000000004'});
 assert.equal(another.ok,true);
 assert.equal(another.reused,false);
 assert.notEqual(another.order.id,id1);
});

test('amount mismatch fails closed and never grants a real item',async()=>{
 const {storage}=makeStorage();let grants=0;
 const c=new PaymentV2LiveCoordinator(storage,env,{fetchFn:fakeProvider(999)});
 assert.equal((await c.create({owner,sku:'shield',uuid:uuid1})).ok,true);
 const invalid=await c.verify({owner,id:id1,bytes:samplePng(),inventory:{grant:async()=>{grants++;return{ok:true}}}});
 assert.equal(invalid.ok,false);
 assert.equal(grants,0);
 assert.equal(c.get({owner,id:id1}).order.status,'pending');
});

test('VIP 100-person full rejection is safe in a future public rollout',async()=>{
 const {storage}=makeStorage();
 const publicEnv={...env,PAYMENT_ROLLOUT:'public'};
 const c=new PaymentV2LiveCoordinator(storage,publicEnv,{authorize:()=>({ok:true})});
 const vip={reserveForCheckout:async()=>({ok:false,reason:'vip_full'})};
 const r=await c.create({owner,sku:'vip',uuid:uuid1,vip});
 assert.equal(r.ok,false);assert.equal(r.reason,'vip_full');
 assert.equal(c.qrPayload({owner,id:id1}).reason,'not_payable');
 assert.equal(c.get({owner,id:id1}).order.status,'cancelled');
});
