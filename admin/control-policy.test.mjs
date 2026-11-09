import test from 'node:test';
import assert from 'node:assert/strict';
import {GameControlPolicy} from './control-policy.mjs';
function make(){
 const map=new Map(),kv={get:k=>map.get(k),put:(k,v)=>map.set(k,v)};
 let now=1000;return {policy:new GameControlPolicy(kv,{clock:()=>now}),map};
}
test('default: both servers open, nobody banned',()=>{
 const {policy}=make();
 assert.equal(policy.access({uid:'uid123',server:'free'}).allowed,true);
 assert.equal(policy.access({uid:'uid123',server:'vip'}).allowed,true);
 assert.equal(policy.getState().bannedTotal,0);
});
test('ban is global across Free/VIP, unban restores both and action logged',()=>{
 const {policy}=make();
 assert.equal(policy.setBan({uid:'user001',banned:true,reason:'Cheating',actor:'owner@example.org'}).ok,true);
 assert.equal(policy.access({uid:'user001',server:'free'}).code,'banned');
 assert.equal(policy.access({uid:'user001',server:'vip'}).code,'banned');
 assert.equal(policy.access({uid:'user002',server:'free'}).allowed,true);
 assert.deepEqual(policy.bansForUids(['user001','user002']),{user001:true,user002:false});
 assert.equal(policy.listBans({limit:5}).total,1);
 assert.equal(policy.setBan({uid:'user001',banned:false,actor:'owner@example.org'}).ok,true);
 assert.equal(policy.access({uid:'user001',server:'vip'}).allowed,true);
 assert.equal(policy.listAudit().at(0).action,'unban');
});
test('maintenance affects only selected server, and not existing rooms if ignoreMaintenance',()=>{
 const {policy}=make();
 policy.setMaintenance({server:'vip',enabled:true,note:'Database work',actor:'owner@example.org'});
 assert.equal(policy.access({uid:'player001',server:'vip'}).code,'maintenance');
 assert.equal(policy.access({uid:'player001',server:'vip',ignoreMaintenance:true}).allowed,true);
 assert.equal(policy.access({uid:'player001',server:'free'}).allowed,true);
 policy.setBan({uid:'player001',banned:true,reason:'Scam',actor:'owner@example.org'});
 assert.equal(policy.access({uid:'player001',server:'vip',ignoreMaintenance:true}).code,'banned');
 policy.setMaintenance({server:'vip',enabled:false,actor:'owner@example.org'});
 assert.equal(policy.getState().vip.enabled,false);
});
test('bad identifiers and free text cannot circumvent validation',()=>{
 const {policy}=make();
 assert.equal(policy.setBan({uid:'bad/email',banned:true,reason:'reason',actor:'owner@example.org'}).ok,false);
 assert.equal(policy.setBan({uid:'good',banned:true,reason:'',actor:'owner@example.org'}).ok,false);
 assert.equal(policy.setBan({uid:'good',banned:true,reason:'<svg/>',actor:'owner@example.org'}).ok,false);
 assert.equal(policy.setMaintenance({server:'x',enabled:true,actor:'owner@example.org'}).ok,false);
 assert.equal(policy.setMaintenance({server:'free',enabled:'true',actor:'owner@example.org'}).ok,false);
});
