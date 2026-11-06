import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createGame,executeRoll,advance,LUCKY_PRIZES,TURN_MS} from '../public/rules.js';
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
class FakeDO {constructor(ctx,env){this.ctx=ctx;this.env=env;}}
function makeClass(start,next){
 const a=source.indexOf('export class '+start),b=source.indexOf('export class '+next,a);
 assert(a>=0&&b>a,'Missing server class '+start);
 return runInNewContext(source.slice(a,b).replace('export class '+start,'class '+start)+'\n'+start+';',{
   DurableObject:FakeDO,Date,crypto:globalThis.crypto,Math,Object,JSON,Set,Map,
   createGame,executeRoll,advance,TURN_MS,LUCKY_PRIZES,randomInt:()=>0,
   validId:s=>typeof s==='string'&&/^[a-zA-Z0-9_:-]{1,128}$/.test(s),
   validRoom:s=>typeof s==='string'&&/^room-[a-f0-9-]{36}$/.test(s),
   clampName:s=>String(s).slice(0,18)
 });
}
function fakeCtx(){
 const kv=new Map(),sockets=[];
 const c={storage:{kv:{get:k=>structuredClone(kv.get(k)),put:(k,v)=>kv.set(k,structuredClone(v))},
   setAlarm:async t=>{c.alarmAt=t;}},getWebSockets:()=>sockets,
   blockConcurrencyWhile:fn=>fn(),alarmAt:0};
 return c;
}
const Lobby=makeClass('Lobby','GameRoom');
const Room=makeClass('GameRoom','Scores');
const Scores=makeClass('Scores','VipMemberships');
function fixtures(){
 const rooms=new Map();
 const NS={idFromName:x=>x,get:id=>{
   if(!rooms.has(id))rooms.set(id,new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}}));
   return rooms.get(id);
 }};
 return {lobby:new Lobby(fakeCtx(),{ROOM:NS}),rooms};
}
const profile=id=>({id,name:id,avatar:0,server:'free',shield:0,rewardX2:false});
test('Repeated match same Google UID cannot take extra seats',async()=>{
 const {lobby,rooms}=fixtures();
 const a=await lobby.assign(profile('a'));
 const again=await lobby.assign(profile('a'));
 assert.equal(a.room,again.room);assert.equal(again.seat,1);assert.equal(again.rejoined,true);
 assert.notEqual(a.ticket,again.ticket);
 const b=await lobby.assign(profile('b')),c=await lobby.assign(profile('c'));
 assert.equal(b.room,a.room);assert.equal(c.room,a.room);
 assert.equal(rooms.get(a.room).load().players.length,3);
 assert.notEqual((await lobby.assign(profile('d'))).room,a.room);
});
test('Room rejoin ticket belongs only to reserved UID and rotates',async()=>{
 const {lobby,rooms}=fixtures();
 const a=await lobby.assign(profile('a'));
 const room=rooms.get(a.room);
 const next=await room.reissueTicket({userId:'a'});
 assert.equal(next.ok,true);assert.notEqual(next.ticket,a.ticket);
 assert.equal(room.load().players[0].ticket,next.ticket);
 assert.equal((await room.reissueTicket({userId:'intruder'})).ok,false);
});
test('Incomplete room expires; cannot rejoin after abandonment',async()=>{
 const {lobby,rooms}=fixtures();
 const a=await lobby.assign(profile('a')),room=rooms.get(a.room);
 assert(room.ctx.alarmAt>Date.now());
 const g=room.load();g.waitExpiresAt=Date.now()-1;room.save(g);
 await room.alarm();
 assert.equal(room.load().status,'abandoned');
 assert.equal((await room.reissueTicket({userId:'a'})).ok,false);
 assert.equal((await room.reserve({profile:profile('b'),ticket:'ticket',roomId:a.room})).ok,false);
});
test('Fake dice or fake points in websocket message do not affect server roll',async()=>{
 const ctx=fakeCtx();
 const room=new Room(ctx,{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}});
 const game=createGame('room-'+crypto.randomUUID());
 game.boxAt=44;game.server='free';game.status='playing';game.current=0;game.turnEndsAt=Date.now()+20000;
 game.players=['a','b','c'].map(id=>({...profile(id),pos:0}));room.save(game);
 const sock=id=>({deserializeAttachment:()=>({pid:id})});
 await room.webSocketMessage(sock('b'),JSON.stringify({type:'roll',dice:6,score:100000}));
 assert.equal(room.load().players[0].pos,0);
 await room.webSocketMessage(sock('a'),JSON.stringify({type:'roll',dice:6,score:100000}));
 assert.equal(room.load().players[0].pos,1); // mocked server randomInt() returns 0
 assert.equal(room.load().current,1);
 await room.webSocketMessage(sock('a'),JSON.stringify({type:'roll',dice:6}));
 assert.equal(room.load().players[0].pos,1);
});
test('Win and box scoring is once per game despite duplicate calls',async()=>{
 const board=new Scores(fakeCtx(),{}),roomId='room-'+crypto.randomUUID();
 assert.equal(await board.credit({id:'a',name:'A',avatar:0,gameId:roomId,points:10}),true);
 assert.equal(await board.credit({id:'a',name:'A',avatar:0,gameId:roomId,points:10}),false);
 assert.equal(await board.creditPrize({id:'a',name:'A',avatar:0,gameId:roomId,points:1000}),true);
 assert.equal(await board.creditPrize({id:'a',name:'A',avatar:0,gameId:roomId,points:1000}),false);
 assert.equal(await board.creditPrize({id:'a',name:'A',avatar:0,gameId:roomId,points:9999}),false);
 assert.equal((await board.getLeaders())[0].score,1010);
});


test('Empty playing rooms stop repeating timer alarms after idle grace',async()=>{
 const room=new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}});
 const game=createGame('room-'+crypto.randomUUID());
 game.players=['a','b','c'].map(id=>({...profile(id),pos:0}));
 game.status='playing';game.turnEndsAt=Date.now()-100;room.save(game);
 await room.alarm();
 assert.equal(room.load().status,'playing');
 assert(room.load().idleDeadline>Date.now());
 const previous=room.load();previous.idleDeadline=Date.now()-1;room.save(previous);
 await room.alarm();
 assert.equal(room.load().status,'abandoned');
});
