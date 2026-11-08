import test from 'node:test';
import assert from 'node:assert/strict';
import {PRODUCTS_V2,createPendingOrder,makeProviderChecks,validateProviderSlip,
 transferFingerprint,providerAccountReady,ORDER_TTL_MS} from './core.mjs';

const now=Date.parse('2026-11-08T06:00:00Z');
const id='11111111-2222-4333-8444-555555555555';
const makeOrder=(sku='vip')=>createPendingOrder({uid:'firebase-uid-12345',sku,uuid:id,now});
const answer=(o,overrides={})=>({
 code:'200200',data:{amount:o.amountBaht,transRef:'ABC1234567890',
   dateTime:new Date(now+20_000).toISOString(),sender:{bank:{id:'004'}},...overrides}
});
const throws=(f,reason)=>assert.throws(f,e=>e.message===reason);

test('VIP remains capped by product definition at 100 THB / 30 days; trial items are separate',()=>{
 assert.equal(PRODUCTS_V2.vip.amountBaht,100);
 assert.equal(PRODUCTS_V2.vip.days,30);
 assert.equal(PRODUCTS_V2.shield.amountBaht,10);
 assert.equal(PRODUCTS_V2.win2.amountBaht,20);
 const o=makeOrder();
 assert.equal(o.expiresAt-o.createdAt,ORDER_TTL_MS);
 assert.equal(o.version,2);
});
test('reject fake SKU and invalid identity, do not trust browser-supplied prices',()=>{
 throws(()=>createPendingOrder({uid:'abcd',sku:'fake',uuid:id,now}),'invalid_product');
 throws(()=>createPendingOrder({uid:'x',sku:'vip',uuid:id,now}),'invalid_user');
 assert.equal(makeOrder('shield').amountBaht,10);
});
test('provider checks always enforce replay, exact merchant account, and exact amount',()=>{
 const o=makeOrder('shield');
 const p=makeProviderChecks(o,{accountType:'02001',accountNumber:'0812345678'});
 assert.equal(p.checkDuplicate,true);
 assert.deepEqual(p.checkReceiver,[{accountType:'02001',accountNumber:'0812345678'}]);
 assert.deepEqual(p.checkAmount,{type:'eq',amount:'10'});
 throws(()=>makeProviderChecks(o,{accountType:'02001',accountNumber:'abc'}),'invalid_receiver');
});
test('provider success requires all conditions, not merely a found slip',()=>{
 const o=makeOrder();
 const good=validateProviderSlip(answer(o),o,{now:now+30_000});
 assert.equal(good.orderId,o.id);
 assert.equal(good.transactionRef,'004:ABC1234567890');
 for(const code of ['200000','200401','200402','200500','200501','401001']){
   throws(()=>validateProviderSlip({...answer(o),code},o,{now:now+30_000}),'provider_checks_not_passed');
 }
});
test('amount, bank reference and transaction timestamp are verified server-side',()=>{
 const o=makeOrder();
 throws(()=>validateProviderSlip(answer(o,{amount:10}),o,{now:now+30_000}),'amount_mismatch');
 throws(()=>validateProviderSlip(answer(o,{transRef:'xx'}),o,{now:now+30_000}),'invalid_transfer_reference');
 throws(()=>validateProviderSlip(answer(o,{sender:{bank:{id:'xxxx'}}}),o,{now:now+30_000}),'invalid_sender_bank');
 throws(()=>validateProviderSlip(answer(o,{dateTime:new Date(now-200_000).toISOString()}),o,{now:now+30_000}),'transfer_outside_order_window');
 throws(()=>validateProviderSlip(answer(o,{dateTime:new Date(now+ORDER_TTL_MS+70_000).toISOString()}),o,{now:now+ORDER_TTL_MS+80_000}),'transfer_outside_order_window');
});
test('stable hash can be used by a unique-indexed Durable Object ledger to block replay',async()=>{
 const o=makeOrder();
 const verified=validateProviderSlip(answer(o),o,{now:now+30_000});
 const a=await transferFingerprint(verified);
 const b=await transferFingerprint(verified);
 assert.match(a,/^[0-9a-f]{64}$/);
 assert.equal(a,b);
});
test('provider preflight rejects wrong shop, expiry, exhausted quota',()=>{
 const account={shopName:'Lucky Game',packageExpiredDate:new Date(now+7*86400000).toISOString(),
   tokenRemaining:10,tokenPerSlip:0.25,creditRemaining:0,checkSlipByCredit:false};
 assert.deepEqual(providerAccountReady(account,{expectedShopName:'Lucky Game',now}),{ok:true});
 assert.equal(providerAccountReady(account,{expectedShopName:'Other Game',now}).reason,'shop_mismatch');
 assert.equal(providerAccountReady({...account,tokenRemaining:0},{expectedShopName:'Lucky Game',now}).reason,'no_quota');
 assert.equal(providerAccountReady({...account,packageExpiredDate:new Date(now-1).toISOString()},{expectedShopName:'Lucky Game',now}).reason,'package_unavailable');
});
