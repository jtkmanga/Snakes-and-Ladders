import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

class FakeDO {constructor(ctx,env){this.ctx=ctx;this.env=env;}}
const ledgerSource=readFileSync(new URL('../src/ledger.js',import.meta.url),'utf8');
const mainSource=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const ProfileInventory=runInNewContext(
  ledgerSource.slice(ledgerSource.indexOf('export class Inventory'))
    .replace('export class Inventory','class Inventory')+'\nInventory;',
  {DurableObject:FakeDO,Date,Object}
);
function ctx(){
  const entries=new Map();
  return {storage:{kv:{get:key=>entries.has(key)?structuredClone(entries.get(key)):undefined,
    put:(key,value)=>entries.set(key,structuredClone(value))}},entries};
}
test('per-account nickname persists after new Inventory instance, not bound to browser storage',async()=>{
 const state=ctx(),one=new ProfileInventory(state,{}),two=new ProfileInventory(state,{});
 assert.equal((await one.getProfile('uid-a')).name,null);
 const saved=await one.setProfile({uid:'uid-a',name:'  น้องแมว  '});
 assert.equal(saved.ok,true);
 assert.equal((await two.getProfile('uid-a')).name,'น้องแมว');
 assert.equal((await two.getProfile('uid-b')).name,null);
 await two.setProfile({uid:'uid-b',name:'จิ้งจอก'});
 assert.equal((await one.getProfile('uid-a')).name,'น้องแมว');
 assert.equal((await one.getProfile('uid-b')).name,'จิ้งจอก');
});
test('nicknames can be updated without modifying player entitlements or inventory',async()=>{
 const store=ctx(),i=new ProfileInventory(store,{});
 store.storage.kv.put('inventory:uid-a',{win2:Date.now()+86400000,shield:Date.now()+86400000});
 assert.equal((await i.setProfile({uid:'uid-a',name:'Jit'})).ok,true);
 assert.equal((await i.setProfile({uid:'uid-a',name:'Po'})).ok,true);
 assert.equal((await i.getProfile('uid-a')).name,'Po');
 assert((await i.getItems('uid-a')).win2>Date.now());
 assert((await i.getItems('uid-a')).shield>Date.now());
});
test('invalid, overlong and HTML-dangerous profile names are rejected',async()=>{
 const i=new ProfileInventory(ctx(),{});
 for(const name of ['', '     ', 'x'.repeat(19), '<img src=x>', 'a\nb', 5, null]){
  const result=await i.setProfile({uid:'uid-a',name});
  assert.equal(result.ok,false,String(name));
 }
 assert.equal((await i.getProfile('uid-a')).name,null);
});
test('authenticated profile API and matchmaking use stored name, not client-supplied name',()=>{
 assert.match(mainSource,/url\.pathname==='\/api\/profile'/);
 assert.match(mainSource,/getAuthorizedUser\(request,env\)/);
 assert.match(mainSource,/setProfile\(\{uid:user\.id,name:body\?\.name\}\)/);
 assert.match(mainSource,/const savedName=\(await items\(\)\.getProfile\(user\.id\)\)\.name/);
 assert.match(mainSource,/name:savedName/);
});
test('leaderboard updates name without changing accumulated points',async()=>{
 const start=mainSource.indexOf('export class Scores'),end=mainSource.indexOf('export class VipMemberships',start);
 const Scores=runInNewContext(mainSource.slice(start,end).replace('export class Scores','class Scores')+'\nScores;',
   {DurableObject:FakeDO,Date,Object,
    validId:s=>typeof s==='string'&&s.length>0,
    validRoom:s=>typeof s==='string'&&s.startsWith('room-'),
    clampName:s=>String(s).trim().slice(0,18),
    LUCKY_PRIZES:[{points:10}]});
 const board=new Scores(ctx(),{});
 await board.credit({id:'uid-a',name:'Old Name',avatar:0,gameId:'room-abc',points:10});
 assert.equal(await board.rename({id:'uid-a',name:'New Name'}),true);
 assert.deepEqual(JSON.parse(JSON.stringify(await board.getLeaders())),[{id:'uid-a',name:'New Name',avatar:0,score:10}]);
});
