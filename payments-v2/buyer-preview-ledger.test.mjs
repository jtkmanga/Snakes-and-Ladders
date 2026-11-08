import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PaymentV2BuyerPreviewLedger} from './buyer-preview-ledger.mjs';

function createStorage(){
  const db=new DatabaseSync(':memory:');
  const storage={
    sql:{exec(query,...args){
      const stmt=db.prepare(query);
      if(/^\s*SELECT\b/i.test(query)){
        const rows=stmt.all(...args);
        return {toArray(){return rows}};
      }
      stmt.run(...args);
      return {toArray(){return []}};
    }},
    transactionSync(callback){
      db.exec('BEGIN IMMEDIATE');
      try{const r=callback();db.exec('COMMIT');return r;}
      catch(e){db.exec('ROLLBACK');throw e;}
    }
  };
  return {storage,db};
}
const uuid=n=>('00000000-0000-4000-8000-'+String(n).padStart(12,'0'));
const oid=n=>'demo-v2-'+uuid(n);
const setup=(time=1700000000000)=>{
  const {storage,db}=createStorage();
  let now=time;
  return {db,ledger:new PaymentV2BuyerPreviewLedger(storage,{clock:()=>now}),
    storage,setNow:x=>{now=x},getNow:()=>now};
};

test('buyer test prices originate server-side; never emit payable QR or genuine rights',()=>{
 const s=setup();
 for(const [sku,price,i] of [['shield',10,1],['win2',20,2],['vip',100,3]]){
   const created=s.ledger.create({uid:'playerA',sku,id:oid(i)});
   assert.equal(created.ok,true);
   assert.equal(created.order.amountBaht,price);
   assert.equal(created.order.status,'test_only');
   assert.equal(created.order.qrPayable,false);
   assert.equal(created.order.realRightsGranted,false);
   assert.equal(created.order.providerCalled,false);
 }
 assert.equal(s.ledger.list({uid:'playerA'}).length,3);
 assert.equal(s.ledger.create({uid:'playerA',sku:'not-a-product',id:oid(4)}).reason,'invalid_demo_input');
});
test('repeated button presses reuse pending order and do not create duplicate purchase',()=>{
 const s=setup(),first=s.ledger.create({uid:'playerA',sku:'vip',id:oid(1)});
 const again=s.ledger.create({uid:'playerA',sku:'vip',id:oid(2)});
 assert.equal(again.ok,true);assert.equal(again.reused,true);assert.equal(first.order.id,again.order.id);
 assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM buyer_v2_demo_orders').get().n,1);
});
test('fake provider rejection leaves order pending; approval is idempotent',()=>{
 const s=setup(),order=s.ledger.create({uid:'playerA',sku:'vip',id:oid(1)}).order;
 for(const scenario of ['unverified','wrong_amount','wrong_receiver','vip_full']){
   const result=s.ledger.simulate({uid:'playerA',id:order.id,scenario});
   assert.equal(result.ok,false);
   assert.equal(result.order.status,'test_only');
 }
 const ok=s.ledger.simulate({uid:'playerA',id:order.id,scenario:'approved'});
 assert.equal(ok.ok,true);assert.equal(ok.order.status,'sim_fulfilled');
 const repeated=s.ledger.simulate({uid:'playerA',id:order.id,scenario:'approved'});
 assert.equal(repeated.alreadyApplied,true);
 assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM buyer_v2_demo_receipts').get().n,1);
});
test('cross-account read and fake fulfillment are blocked',()=>{
 const s=setup(),order=s.ledger.create({uid:'playerA',sku:'shield',id:oid(1)}).order;
 assert.deepEqual(s.ledger.list({uid:'playerB'}),[]);
 assert.equal(s.ledger.simulate({uid:'playerB',id:order.id,scenario:'approved'}).reason,'not_found');
 assert.equal(s.ledger.simulate({uid:'playerA',id:'demo-v2-invalid',scenario:'approved'}).reason,'invalid_demo_input');
});
test('expired demo order is rejected, new order allowed and history survives DO recreation',()=>{
 const s=setup(),first=s.ledger.create({uid:'playerA',sku:'vip',id:oid(1)}).order;
 s.setNow(s.getNow()+900001);
 assert.equal(s.ledger.simulate({uid:'playerA',id:first.id,scenario:'approved'}).reason,'demo_expired');
 const second=s.ledger.create({uid:'playerA',sku:'vip',id:oid(2)});
 assert.equal(second.ok,true);assert.notEqual(second.order.id,first.id);
 const recreated=new PaymentV2BuyerPreviewLedger(s.storage,{clock:s.getNow});
 assert.deepEqual(recreated.list({uid:'playerA'}).map(x=>x.id),[second.order.id,first.id]);
});
test('daily limit is enforced across products and error never creates payment rights',()=>{
 const s=setup();
 for(let i=1;i<=12;i++){
   const created=s.ledger.create({uid:'playerA',sku:'shield',id:oid(i)});
   assert.equal(created.ok,true);
   s.setNow(s.getNow()+900010);
 }
 assert.equal(s.ledger.create({uid:'playerA',sku:'shield',id:oid(13)}).reason,'daily_demo_limit');
 assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM buyer_v2_demo_orders WHERE status='sim_fulfilled'").get().n,0);
});
