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
