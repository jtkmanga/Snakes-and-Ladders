import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
// Test the actual server class with a minimal in-memory DO storage stub; no Cloudflare credentials needed.
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const start=source.indexOf('export class VipMemberships');
assert(start>=0);
let now=Date.now();
class FakeDO{constructor(ctx){this.ctx=ctx;}}
const VipMemberships=runInNewContext(source.slice(start).replace('export class VipMemberships','class VipMemberships')+'\nVipMemberships;',{
  DurableObject:FakeDO,VIP_LIMIT:100,VIP_DURATION_MS:30*86_400_000,
  Date:{now:()=>now},Object,Math
});
function fakeRoom(){
  const entries=new Map();
  return new VipMemberships({storage:{kv:{get:k=>entries.get(k),put:(k,v)=>entries.set(k,structuredClone(v))}}},{});
}
test('VIP cannot reserve 101st active membership and can reserve after expiry',async()=>{
 const room=fakeRoom();now=Date.now();
 for(let i=0;i<100;i++){
  const who=`user-${i}`,order=`order-${i}`;
  assert.equal((await room.reserveForCheckout({userId:who,orderId:order})).ok,true);
  assert.equal((await room.activateAfterVerifiedPayment({userId:who,orderId:order,transactionId:`txn-${i}`})).ok,true);
 }
 const s=await room.getStatus();assert.equal(s.active,100);assert.equal(s.available,0);assert.equal(s.full,true);
 assert.equal((await room.reserveForCheckout({userId:'user-101',orderId:'order-new'})).reason,'vip_full');
 now+=30*86_400_000+1;
 const refreshed=await room.getStatus();assert.equal(refreshed.active,0);assert.equal(refreshed.available,100);
 assert.equal((await room.reserveForCheckout({userId:'user-101',orderId:'order-new'})).ok,true);
});
test('VIP pending holds count toward 100 slots and expire after 15 minutes',async()=>{
 const room=fakeRoom();now=Date.now();
 for(let i=0;i<100;i++)assert.equal((await room.reserveForCheckout({userId:`p-${i}`,orderId:`o-${i}`})).ok,true);
 let s=await room.getStatus();assert.equal(s.reserved,100);assert.equal(s.active,0);assert.equal(s.available,0);
 assert.equal((await room.reserveForCheckout({userId:'p-excess',orderId:'new-order'})).ok,false);
 now+=15*60_000+1;
 s=await room.getStatus();assert.equal(s.reserved,0);assert.equal(s.available,100);
});
test('VIP activation requires matching hold and does not double-credit receipt',async()=>{
 const room=fakeRoom();now=Date.now();
 assert.equal((await room.activateAfterVerifiedPayment({userId:'p',orderId:'order',transactionId:'t1'})).ok,false);
 await room.reserveForCheckout({userId:'p',orderId:'order'});
 const first=await room.activateAfterVerifiedPayment({userId:'p',orderId:'order',transactionId:'t1'});
 assert.equal(first.ok,true);
 const retry=await room.activateAfterVerifiedPayment({userId:'p',orderId:'order',transactionId:'t1'});
 assert.equal(retry.alreadyApplied,true);assert.equal(retry.expiresAt,first.expiresAt);
 assert.equal((await room.activateAfterVerifiedPayment({userId:'other',orderId:'order',transactionId:'t1'})).reason,'duplicate_receipt');
 assert.equal((await room.getStatus()).active,1);
 await room.reserveForCheckout({userId:'p',orderId:'second'});
 const renew=await room.activateAfterVerifiedPayment({userId:'p',orderId:'second',transactionId:'t2'});
 assert.equal(renew.expiresAt,first.expiresAt+30*86_400_000);
 assert.equal((await room.getStatus()).active,1);
});
