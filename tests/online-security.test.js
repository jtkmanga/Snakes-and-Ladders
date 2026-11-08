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


test('After two consecutive skipped turns the room remains active',async()=>{
 const room=new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}});
 const game=createGame('room-'+crypto.randomUUID());
 game.players=['a','b','c'].map(id=>({...profile(id),pos:0}));
 game.status='playing';game.turnEndsAt=Date.now()-TURN_MS-100;room.save(game);
 await room.timeout(game);
 assert.equal(room.load().status,'playing');
 assert.equal(room.load().noRollTurns,2);
 assert.equal(room.load().current,2);
});
test('The third consecutive skipped turn ends the room with no winner or points',async()=>{
 const room=new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}});
 const game=createGame('room-'+crypto.randomUUID());
 game.players=['a','b','c'].map(id=>({...profile(id),pos:0}));
 game.status='playing';game.turnEndsAt=Date.now()-2*TURN_MS-100;room.save(game);
 await room.timeout(game);
 const result=room.load();
 assert.equal(result.status,'abandoned');
 assert.equal(result.closeReason,'no_rolls_3_turns');
 assert.equal(result.noRollTurns,3);
 assert.equal(result.winnerId,null);
 assert.equal((await room.reissueTicket({userId:'a'})).ok,false);
});
test('One player successfully rolling resets the no-roll counter and room continues',async()=>{
 const room=new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}});
 const game=createGame('room-'+crypto.randomUUID());
 game.players=['a','b','c'].map(id=>({...profile(id),pos:0}));
 game.status='playing';game.noRollTurns=2;game.boxAt=44;game.turnEndsAt=Date.now()+TURN_MS;room.save(game);
 const socket={deserializeAttachment:()=>({pid:'a'}),send:()=>{}};
 room.ctx.getWebSockets().push(socket);
 await room.webSocketMessage(socket,JSON.stringify({type:'roll'}));
 assert.equal(room.load().status,'playing');
 assert.equal(room.load().noRollTurns,0);
 assert.equal(room.load().players[0].pos,1);
 assert.equal(room.load().current,1);
 const after=room.load();
 after.turnEndsAt=Date.now()-100;room.save(after);
 await room.timeout(after);
 assert.equal(room.load().status,'playing');
 assert.equal(room.load().noRollTurns,1);
});
test('An empty room sets one consolidated alarm for three skipped turns',async()=>{
 const room=new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}});
 const game=createGame('room-'+crypto.randomUUID());
 game.players=['a','b','c'].map(id=>({...profile(id),pos:0}));
 game.status='playing';game.turnEndsAt=Date.now()+TURN_MS;room.save(game);
 await room.webSocketClose({});
 const deadline=game.turnEndsAt+2*TURN_MS;
 assert.equal(room.ctx.alarmAt,deadline);
 const elapsed=room.load();
 elapsed.turnEndsAt=Date.now()-2*TURN_MS-100;room.save(elapsed);
 await room.alarm();
 assert.equal(room.load().status,'abandoned');
});
test('Rejoining the room cannot reset missed rolls or extend turn deadline',async()=>{
 const room=new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}});
 const game=createGame('room-'+crypto.randomUUID());
 game.players=['a','b','c'].map((id,seat)=>({...profile(id),pos:0,ticket:'old-'+seat,issuedAt:Date.now()}));
 game.status='playing';game.noRollTurns=2;game.turnEndsAt=Date.now()+TURN_MS;room.save(game);
 const renewed=await room.reissueTicket({userId:'b'});
 assert.equal(renewed.ok,true);
 assert.equal(room.load().noRollTurns,2);
 assert.equal(room.load().turnEndsAt,game.turnEndsAt);
});
test('Remaining one or two active players can keep a game alive with legitimate rolls',async()=>{
 const room=new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}});
 const game=createGame('room-'+crypto.randomUUID());
 game.players=['a','b','c'].map(id=>({...profile(id),pos:0}));
 game.status='playing';game.boxAt=44;game.turnEndsAt=Date.now()+TURN_MS;room.save(game);
 const socket={deserializeAttachment:()=>({pid:'a'}),send:()=>{}};
 room.ctx.getWebSockets().push(socket);
 for(let round=0;round<5;round++){
   const g=room.load();g.noRollTurns=2;g.current=0;g.turnEndsAt=Date.now()+TURN_MS;room.save(g);
   await room.webSocketMessage(socket,JSON.stringify({type:'roll'}));
   assert.equal(room.load().noRollTurns,0);
   assert.equal(room.load().status,'playing');
 }
});

// A room may close after 3 rounds while its earned prize still awaits credit.
test('Lucky Box credit retries survive automatic closure after three silent turns',async()=>{
 const room=new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({
   credit:async()=>true,creditPrize:async()=>{throw Error('Temporary score outage');}
 })}});
 const game=createGame('room-'+crypto.randomUUID());
 game.players=['a','b','c'].map(id=>({...profile(id),pos:0}));
 game.server='free';game.boxUsed=true;game.boxWinnerId='a';game.boxReward=100;
 game.prizeCredited=false;game.status='playing';
 game.turnEndsAt=Date.now()-2*TURN_MS-100;room.save(game);
 await room.alarm();
 assert.equal(room.load().status,'abandoned');
 assert.equal(room.load().prizeCredited,false);
 assert(room.ctx.alarmAt>Date.now(),'Award retry should be scheduled');
});
test('Even connected players are closed after three skipped turns without rolling',async()=>{
 const room=new Room(fakeCtx(),{SCORES:{idFromName:x=>x,get:()=>({credit:async()=>true,creditPrize:async()=>true})}});
 const game=createGame('room-'+crypto.randomUUID());
 game.players=['a','b','c'].map(id=>({...profile(id),pos:0}));
 game.status='playing';game.turnEndsAt=Date.now()-2*TURN_MS-100;room.save(game);
 const closed=[];
 for(const id of ['a','b','c'])room.ctx.getWebSockets().push({
   deserializeAttachment:()=>({pid:id}),send:()=>{},close:(code)=>closed.push([id,code])
 });
 await room.timeout(game);
 assert.equal(room.load().status,'abandoned');
 assert.equal(closed.length,3);
 assert(closed.every(([id,code])=>code===4003));
});
