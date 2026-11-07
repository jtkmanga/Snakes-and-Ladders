import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const main=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const ledgerSource=readFileSync(new URL('../src/ledger.js',import.meta.url),'utf8');
let now=Date.now();
const Clock={now:()=>now};
class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}
const Vip=runInNewContext(main.slice(main.indexOf('export class VipMemberships')).replace('export class VipMemberships','class VipMemberships')+'\nVipMemberships;',{
  DurableObject,Date:Clock,VIP_LIMIT:100,VIP_DURATION_MS:30*86_400_000,Object,Math
});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const fulfillOrder=runInNewContext(main.slice(main.indexOf('const publicOrder='),main.indexOf('\nexport default'))+'\nfulfillOrder;',{
  json,console
});
function ctx(){
 const db=new Map();
 return {storage:{kv:{get:k=>db.get(k),put:(k,v)=>db.set(k,structuredClone(v))}}};
}
function setup(){
 now=Date.now();
 const vip=new Vip(ctx(),{});
 const orders=new Map();
 const ledger={
   markFulfilled:({id,uid})=>{
     const o=orders.get(id);
     if(o?.uid!==uid||o.status!=='verified')return {ok:false};
     o.status='fulfilled';o.fulfilled_at=now;
     return {ok:true};
   },
   get:(id,uid)=>{const o=orders.get(id);return o?.uid===uid?o:null;}
 };
 const env={
   VIP:{idFromName:id=>id,get:id=>vip},
   PAYMENTS:{idFromName:id=>id,get:id=>ledger},
   ITEMS:{idFromName:id=>id,get:id=>({grant:async()=>({ok:false})})}
 };
 const add=(uid,id)=>{const o={id,uid,sku:'vip',amount:100,status:'verified',
  tx_hash:'txn-'+id,created_at:now-900000,expires_at:now,fulfilled_at:null};orders.set(id,o);return o;};
 return {vip,ledger,env,add,orders};
}
test('a previously verified VIP payment can recover an expired seat hold if still available',async()=>{
 const {vip,env,add,orders}=setup();
 const order=add('a','order-verified');
 assert.equal((await vip.reserveForCheckout({userId:'a',orderId:order.id})).ok,true);
 now+=15*60_000+100;
 const response=await fulfillOrder(order,{id:'a'},env);
 assert.equal(response.status,200);
 assert.equal((await response.json()).ok,true);
 assert.equal(orders.get(order.id).status,'fulfilled');
 assert.equal((await vip.getStatus()).active,1);
 assert.equal(await vip.hasAccess('a'),true);
});
test('a verified VIP payment never exceeds 100 members after its original hold expires',async()=>{
 const {vip,env,add,orders}=setup();
 const order=add('a','order-verified');
 await vip.reserveForCheckout({userId:'a',orderId:order.id});
 now+=15*60_000+100;
 for(let i=0;i<100;i++){
   const id='member-'+i;
   assert.equal((await vip.reserveForCheckout({userId:id,orderId:'o-'+i})).ok,true);
   assert.equal((await vip.activateAfterVerifiedPayment({userId:id,orderId:'o-'+i,transactionId:'tx-'+i})).ok,true);
 }
 const r=await fulfillOrder(order,{id:'a'},env);
 assert.equal(r.status,409);
 const data=await r.json();
 assert.equal(data.status,'verified_not_fulfilled');
 assert.equal(data.orderId,order.id);
 assert.equal(orders.get(order.id).status,'verified');
 assert.equal((await vip.getStatus()).active,100);
 assert.equal(await vip.hasAccess('a'),false);
});
test('reconciliation never issues a second VIP entitlement on repeated settlement',async()=>{
 const {vip,env,add}=setup();
 const order=add('a','order-paid');
 await vip.reserveForCheckout({userId:'a',orderId:order.id});
 const first=await fulfillOrder(order,{id:'a'},env);
 assert.equal(first.status,200);
 const prior=(await vip.getStatus()).active;
 const second=await fulfillOrder(order,{id:'a'},env);
 assert.equal(second.status,200);
 assert.equal((await vip.getStatus()).active,prior);
});
test('never create a charge when VIP capacity check fails and pending order is cancelled',()=>{
 const mainHasGuard=main.includes('await ledger().cancelPending({id:order.id,uid:user.id})');
 assert.equal(mainHasGuard,true);
 const start=ledgerSource.indexOf('  cancelPending({id,uid}){');
 const end=ledgerSource.indexOf('\n  takeVerification(',start);
 assert(start>0&&end>start);
 const method=ledgerSource.slice(start,end).replace(/^  cancelPending/,'cancelPending');
 const cancel=runInNewContext('({'+method+'}).cancelPending;',{});
 const saved={id:'order-1',uid:'a',status:'pending'};
 const sql=[];
 const obj={get:()=>saved,ctx:{storage:{sql:{exec:(...args)=>sql.push(args)}}}};
 assert.equal(cancel.call(obj,{id:'order-1',uid:'a'}).ok,true);
 assert.equal(sql.length,1);
 saved.status='verified';
 assert.equal(cancel.call(obj,{id:'order-1',uid:'a'}).ok,false);
 assert.equal(sql.length,1);
});

test('ledger finalization failure never reports payment completed, and retry remains idempotent',async()=>{
 const {vip,env,add,ledger,orders}=setup();
 const order=add('a','order-retry-finalization');
 await vip.reserveForCheckout({userId:'a',orderId:order.id});
 const realMark=ledger.markFulfilled;
 ledger.markFulfilled=()=>({ok:false});
 const first=await fulfillOrder(order,{id:'a'},env);
 assert.equal(first.status,503);
 assert.equal((await first.json()).status,'verified_not_fulfilled');
 assert.equal(order.status,'verified');
 assert.equal((await vip.getStatus()).active,1);
 const expiry=vip.state().members.a.expiresAt;
 ledger.markFulfilled=realMark;
 const second=await fulfillOrder(order,{id:'a'},env);
 assert.equal(second.status,200);
 assert.equal(order.status,'fulfilled');
 assert.equal(vip.state().members.a.expiresAt,expiry);
});
