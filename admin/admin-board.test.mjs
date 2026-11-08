import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {nextResetAt,AdminBoard} from './admin-board.mjs';
const DAY=86400000,UTC=Date.UTC;
function store(){
 const db=new DatabaseSync(':memory:');
 return{db,storage:{sql:{exec(sql,...args){const stmt=db.prepare(sql);if(/^\s*SELECT/i.test(sql))return{toArray:()=>stmt.all(...args)};stmt.run(...args);return{toArray:()=>[]}}},
 transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}}};
}
test('VIP resets daily midnight Bangkok even when requested before/after clock boundary',()=>{
 assert.equal(nextResetAt(UTC(2026,10,8,16,59,59),'vip'),UTC(2026,10,8,17,0,0));
 assert.equal(nextResetAt(UTC(2026,10,8,17,0,0),'vip'),UTC(2026,10,9,17,0,0));
});
test('Free scoreboard resets only Sunday 00:00 Bangkok, never Saturday or Sunday midday',()=>{
 assert.equal(nextResetAt(UTC(2026,10,7,16,59,59),'free'),UTC(2026,10,7,17,0,0));
 assert.equal(nextResetAt(UTC(2026,10,7,17,0,0),'free'),UTC(2026,10,14,17,0,0));
 assert.equal(nextResetAt(UTC(2026,10,8,7,0,0),'free'),UTC(2026,10,14,17,0,0));
});
test('player score is separated by registry, online TTL and email is read-only',()=>{
 const a=new AdminBoard(store().storage),b=new AdminBoard(store().storage);
 a.touch({id:'player01',email:'one@example.org',name:'Player One',online:true},1000000);
 a.award({id:'player01',name:'Player One',avatar:0,points:20},1000001);
 b.touch({id:'player01',email:'one@example.org',name:'Player One',online:false},1000000);
 assert.equal(a.leaders()[0].score,20);
 assert.deepEqual(b.leaders(),[]);
 assert.equal(a.players({onlineOnly:true,now:1000000}).online,1);
 assert.equal(a.players({onlineOnly:true,now:1000000+90001}).total,0);
 const edited=a.edit({uid:'player01',score:123,name:'Renamed'},'admin@example.org',1000010);
 assert.equal(edited.ok,true);
 assert.equal(edited.player.email,'one@example.org');
 assert.equal(edited.player.score,123);
 assert.equal(a.edit({uid:'player01',score:-2},'admin@example.org').ok,false);
 assert.equal(a.edit({uid:'player01',score:1.5},'admin@example.org').ok,false);
});
test('winner snapshot is durable BEFORE score reset; audit stores actor and server',()=>{
 const {storage}=store(),a=new AdminBoard(storage);
 a.touch({id:'player01',email:'one@example.org',name:'Alice',online:true},1e6);
 a.touch({id:'player02',email:'two@example.org',name:'Bob',online:true},1e6);
 a.award({id:'player01',name:'Alice',points:10,avatar:1},1e6);
 a.award({id:'player02',name:'Bob',points:20,avatar:1},1e6);
 const result=a.reset({at:1e6+1000,mode:'auto',actor:'scheduler',server:'vip'});
 assert.equal(result.winner.id,undefined); // database winner uses uid, not player id
 assert.equal(result.winner.uid,'player02');
 assert.equal(result.winner.score,20);
 assert.deepEqual(a.leaders(),[]);
 assert.equal(a.players({now:1e6}).players.find(p=>p.uid==='player01').score,0);
 const saved=a.history()[0];
 assert.equal(saved.email,'two@example.org');
 assert.equal(saved.name,'Bob');
 assert.equal(saved.score,20);
 assert.equal(saved.mode,'auto');
 assert.equal(a.audits()[0].action,'reset_vip');
});
