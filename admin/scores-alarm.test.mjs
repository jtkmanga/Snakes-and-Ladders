import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {AdminBoard,nextResetAt} from './admin-board.mjs';
const code=readFileSync(fileURLToPath(new URL('./scores-v76.txt',import.meta.url)),'utf8').replace('export class Scores','class Scores');
class FakeDO {constructor(ctx,env){this.ctx=ctx;this.env=env;}}
const Score=Function('DurableObject','AdminBoard','nextResetAt','validId','validRoom','LUCKY_PRIZES',code+'\nreturn Scores;')(
 FakeDO,AdminBoard,nextResetAt,
 id=>typeof id==='string'&&/^[A-Za-z0-9_:-]{1,128}$/.test(id),
 id=>/^room-[a-f0-9-]{36}$/.test(id),
 [{points:5}]
);
function make(){
 const db=new DatabaseSync(':memory:'),kvMap=new Map(),alarms=[];
 const storage={
  sql:{exec(q,...args){const st=db.prepare(q);if(/^\s*SELECT/i.test(q))return{toArray:()=>st.all(...args)};st.run(...args);return{toArray:()=>[]}}},
  transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}},
  kv:{get:k=>kvMap.get(k),put:(k,v)=>kvMap.set(k,v)}
 };
 storage.setAlarm=async v=>{alarms.push(v)};
 const ctx={storage};
 return{board:new Score(ctx,{}),kvMap,alarms,db};
}
test('Free Score DO initializes Sunday midnight Bangkok alarm and winners are captured on alarm',async()=>{
 const old=Date.now;
 let clock=Date.UTC(2026,10,8,7,0);Date.now=()=>clock;
 try{
  const {board,kvMap,alarms}=make();
  assert.deepEqual(await board.getLeaders('free'),[]);
  assert.equal(alarms.at(-1),Date.UTC(2026,10,14,17,0));
  const uid='player001',room='room-00000000-0000-4000-8000-000000000011';
  assert.equal(await board.credit({id:uid,name:'First',avatar:0,gameId:room,points:10,server:'free'}),true);
  assert.equal(await board.credit({id:uid,name:'First',avatar:0,gameId:room,points:10,server:'free'}),false);
  await board.heartbeat({id:uid,email:'first@example.org',name:'First',avatar:0,server:'free'});
  assert.equal((await board.getLeaders('free'))[0].score,10);
  clock=Date.UTC(2026,10,14,17,0)+1000;
  await board.alarm();
  assert.deepEqual(await board.getLeaders('free'),[]);
  const result=await board.adminHistory({server:'free'});
  assert.equal(result.history[0].name,'First');
  assert.equal(result.history[0].score,10);
  assert.equal(result.history[0].email,'first@example.org');
  assert.equal(alarms.at(-1),Date.UTC(2026,10,21,17,0));
  assert.equal(kvMap.get('admin:server'),'free');
 }finally{Date.now=old}
});
test('VIP schedule is every Bangkok midnight and manual reset keeps automatic alarm',async()=>{
 const old=Date.now;
 let clock=Date.UTC(2026,10,8,7,0);Date.now=()=>clock;
 try{
  const {board,alarms}=make();
  await board.getLeaders('vip');
  const next=alarms.at(-1);
  assert.equal(next,Date.UTC(2026,10,8,17,0));
  const now=await board.adminReset({server:'vip',actor:'admin@example.org'});
  assert.equal(now.nextReset,next);
  assert.equal(alarms.at(-1),next);
 }finally{Date.now=old}
});
