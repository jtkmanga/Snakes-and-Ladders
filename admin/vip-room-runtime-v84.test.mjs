import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createGame,roomCapacity,roomSizeForServer,advance,TURN_MS} from './rules-v84.mjs';
const path=fileURLToPath(new URL('./staging-main-v84.mjs',import.meta.url));
const src=readFileSync(path,'utf8');
const a=src.indexOf('export class Lobby extends DurableObject {'),b=src.indexOf('export class Scores extends DurableObject {',a);
if(a<0||b<0)throw Error('Cannot load real Lobby and GameRoom source');
class FakeDO{constructor(ctx,env){this.ctx=ctx;this.env=env;}}
class FakeWs{
 constructor(){this.attachment=null;this.sent=[];}
 serializeAttachment(value){this.attachment=value;}
 deserializeAttachment(){return this.attachment;}
 send(value){this.sent.push(value);}
 close(){}
}
class FakePair{constructor(){this[0]=new FakeWs();this[1]=new FakeWs();}}
class FakeResponse{constructor(body,opts){this.body=body;this.status=opts?.status;this.webSocket=opts?.webSocket;}}
const cls=src.slice(a,b).replaceAll('export class ','class ');
const {Lobby,GameRoom}=new Function('DurableObject','createGame','roomCapacity','roomSizeForServer','crypto','TURN_MS','WebSocketPair','Response','json','advance',cls+'\nreturn {Lobby,GameRoom};')(
 FakeDO,createGame,roomCapacity,roomSizeForServer,globalThis.crypto,TURN_MS,FakePair,FakeResponse,
 (data,status=200)=>({status,data}),advance
);
function makeStore(){
 const kvMap=new Map(),alarms=[],sockets=[];
 return{
  ctx:{
   storage:{kv:{get:key=>kvMap.get(key),put:(key,v)=>kvMap.set(key,v)},setAlarm:async t=>alarms.push(t)},
   getWebSockets:()=>sockets,acceptWebSocket:s=>sockets.push(s),
   blockConcurrencyWhile:async fn=>fn()
  },
  kvMap,sockets,alarms
 };
}
function createHarness(){
 const rooms=new Map(),free=makeStore(),vip=makeStore();
 const env={
  ITEMS:{idFromName:x=>x,get:()=>({gameAccess:async()=>({allowed:true})})},
  ROOM:{idFromName:x=>x,get(id){if(!rooms.has(id))rooms.set(id,{room:new GameRoom(makeStore().ctx,env)});return rooms.get(id).room;}}
 };
 const freeLobby=new Lobby(free.ctx,env),vipLobby=new Lobby(vip.ctx,env);
 const player=(id,server)=>({id,server,name:id,avatar:0,shield:0,rewardX2:false});
 const join=async(id,server)=>server==='vip'?vipLobby.assign(player(id,server)):freeLobby.assign(player(id,server));
 const connect=async r=>{
  const room=env.ROOM.get(r.room);
  const result=await room.fetch({headers:{get:n=>n.toLowerCase()==='upgrade'?'websocket':null},url:'https://room.example/ws?ticket='+encodeURIComponent(r.ticket)});
  assert.equal(result.status,101);
  return room.load();
 };
 return{env,rooms,free,vip,join,connect,player};
}
test('new VIP room starts only after 2 actual connected players and third gets another room',async()=>{
 const h=createHarness();
 const a=await h.join('vipOne','vip');
 assert.equal(a.maxPlayers,2);
 const b=await h.join('vipTwo','vip');
 assert.equal(a.room,b.room);
 assert.equal(b.maxPlayers,2);
 const room=h.env.ROOM.get(a.room);
 assert.equal(room.load().status,'waiting');
 await h.connect(a);assert.equal(room.load().status,'waiting');
 await h.connect(b);assert.equal(room.load().status,'playing');
 assert.equal(room.load().players.length,2);
 assert.equal(room.load().maxPlayers,2);
 assert.ok(room.load().turnEndsAt>Date.now());
 const c=await h.join('vipThree','vip');
 assert.notEqual(c.room,a.room);
 assert.equal(c.maxPlayers,2);
 assert.equal(h.env.ROOM.get(c.room).load().status,'waiting');
});
test('Free room remains 3 players, and VIP queue stays independent',async()=>{
 const h=createHarness();
 const a=await h.join('freeOne','free'),b=await h.join('freeTwo','free');
 assert.equal(a.room,b.room);assert.equal(a.maxPlayers,3);
 const vip=await h.join('vipOne','vip');assert.notEqual(vip.room,a.room);
 await h.connect(a);await h.connect(b);
 assert.equal(h.env.ROOM.get(a.room).load().status,'waiting');
 const c=await h.join('freeThree','free');assert.equal(c.room,a.room);
 await h.connect(c);assert.equal(h.env.ROOM.get(a.room).load().status,'playing');
 assert.equal(h.env.ROOM.get(a.room).load().players.length,3);
 const next=await h.join('freeFour','free');assert.notEqual(next.room,a.room);
});
test('legacy VIP waiting room remains 3 seats (avoid changing active room mid-game)',async()=>{
 const h=createHarness();
 const roomId='room-11111111-1111-4111-8111-111111111111';
 const room=h.env.ROOM.get(roomId);
 const original=createGame(roomId,'vip');delete original.maxPlayers;
 original.server='vip';original.waitExpiresAt=Date.now()+120000;
 original.players=[{id:'oldVip',name:'oldVip',avatar:0,pos:0,shield:0,stars:0,ticket:'ticket',issuedAt:Date.now()}];
 room.save(original);
 h.vip.kvMap.set('waiting',{roomId,count:1,created:Date.now()});
 const b=await h.join('newVip','vip');
 assert.equal(b.room,roomId);assert.equal(b.maxPlayers,3);
 assert.equal(room.load().players.length,2);
 assert.equal(roomCapacity(room.load()),3);
});
