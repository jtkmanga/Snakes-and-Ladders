#!/usr/bin/env node
/**
 * Independently authored PUBLIC, SYNTHETIC-ONLY multiplayer test client.
 * Exercises an isolated VIP Lab via short-lived GitHub OIDC, no private source.
 * Never uses real player identities, purchases, production endpoints or keys.
 */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import WebSocket from 'ws';

const HOST='snakes-and-ladders-game-loadlab.jtkmanga.workers.dev';
const API='https://'+HOST, WSS='wss://'+HOST;
const AUDIENCE=API+'/oidc/v1';
const CLIENT_LIMIT=100, ROOM_LIMIT=50, CONNECTION_LIMIT=101;
const HARD_LIMIT_MS=230000, PLAY_MS=65000, IDLE_MS=68000;
const ROLL_SPACING_MS=9000, PAIR_BATCH=2;
const STAGES=[10,30,100];
assert.equal(process.argv.length,2,'CLI overrides prohibited');
assert.equal(process.env.GITHUB_REPOSITORY,'jtkmanga/Snakes-and-Ladders');
assert.equal(process.env.GITHUB_REF,'refs/heads/main');
assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
assert.equal(process.env.RUN_ISOLATED_VIP100_GAMEPLAY,'confirmed-manual-100-gameplay');
const origin=performance.now(),all=[],byId=new Map(),warnings=[];
let bearer=null,cutoff=false,requests=0;
const kill=setTimeout(()=>{
 cutoff=true;
 for(const c of all)try{c.socket.terminate()}catch{}
},HARD_LIMIT_MS);
function ensure(){
 assert.ok(!cutoff&&performance.now()-origin<HARD_LIMIT_MS,'Hard time safety gate');
}
async function gitHubIdentity(){
 const endpoint=process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
 const runtime=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
 assert.ok(endpoint?.startsWith('https://')&&runtime?.length>10);
 const u=new URL(endpoint);u.searchParams.set('audience',AUDIENCE);
 const r=await fetch(u,{headers:{Authorization:'Bearer '+runtime},
  redirect:'error',signal:AbortSignal.timeout(9000)});
 assert.equal(r.status,200,'GitHub OIDC issue refused');
 const x=await r.json();
 assert.ok(typeof x.value==='string'&&x.value.length>=128&&x.value.length<=8192);
 return x.value;
}
async function call(path,body){
 ensure();
 assert.ok(['/lab/session','/lab/match','/lab/status'].includes(path));
 requests++;
 const res=await fetch(API+path,{
  method:body===undefined?'GET':'POST',
  headers:{Authorization:'Bearer '+bearer,...(body===undefined?{}:{'Content-Type':'application/json'})},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
  redirect:'error',signal:AbortSignal.timeout(11000)
 });
 assert.equal(res.ok,true,'Synthetic Lab refused '+path+' HTTP '+res.status);
 return res.json();
}
async function until(check,ms,label){
 const stop=performance.now()+ms;
 while(performance.now()<stop){ensure();if(check())return;await sleep(85)}
 throw Error('Timeout: '+label);
}
function currentState(c){return c.states.at(-1)||null}
function openCount(){return [...byId.values()].filter(x=>x.socket.readyState===WebSocket.OPEN).length}
async function connect(ticket,identity){
 ensure();assert.ok(all.length<CONNECTION_LIMIT,'Too many total synthetic connections');
 assert.ok(/^lab-[0-9]{1,4}$/.test(identity));
 return new Promise((resolve,reject)=>{
  const uri=WSS+'/lab/ws?room='+encodeURIComponent(ticket.room)+
    '&ticket='+encodeURIComponent(ticket.ticket);
  const socket=new WebSocket(uri,{headers:{Authorization:'Bearer '+bearer},handshakeTimeout:9000});
  const entry={id:identity,room:ticket.room,socket,states:[],code:null,expected:null};
  all.push(entry);
  let settled=false;
  const timer=setTimeout(()=>fail('upgrade_timeout'),9000);
  function fail(what){
   if(settled)return;
   settled=true;clearTimeout(timer);reject(Error('Synthetic socket '+what));
  }
  socket.on('open',()=>{if(settled)return;settled=true;clearTimeout(timer);resolve(entry)});
  socket.on('message',data=>{
   try{
    const message=JSON.parse(String(data));
    if(message.type==='state'&&message.state&&typeof message.state==='object'){
     entry.states.push(message.state);
     if(entry.states.length>6)entry.states.shift();
    }
   }catch{}
  });
  socket.on('error',()=>{if(!settled)fail('error');else warnings.push({kind:'socket_error'})});
  socket.on('close',code=>{
   entry.code=code;
   if(!settled)fail('closed_before_open');
   else if(code!==1000&&code!==entry.expected)warnings.push({kind:'unexpected_close',code});
  });
  socket.on('unexpected-response',(_,response)=>{response.resume();fail('upgrade_http_'+response.statusCode)});
 });
}
async function admit(id,session){
 const booking=await call('/lab/match',{session,id,server:'vip'});
 assert.equal(booking.playerId,id);assert.equal(booking.maxPlayers,2);
 assert.match(booking.room,/^room-[0-9a-f-]{36}$/);
 return {booking,entry:await connect(booking,id)};
}
const percentile=(items)=>items.length?Math.round([...items].sort((a,b)=>a-b)[Math.ceil(.95*items.length)-1]):0;
function groupRooms(){
 const map=new Map();
 for(const person of byId.values()){
  const pair=map.get(person.room)||[];
  pair.push(person);
  map.set(person.room,pair);
 }
 assert.equal(map.size,ROOM_LIMIT,'VIP must allocate exactly fifty rooms');
 for(const pair of map.values())assert.equal(pair.length,2,'VIP seat count changed');
 return [...map.values()].map((members,index)=>({index,members,pending:null,sentAt:0,
  nextAt:0,confirmed:0,finished:false}));
}
async function checkStage(expected){
 await until(()=>[...byId.values()].every(p=>currentState(p)?.status==='playing'),6500,'stage playing');
 assert.equal(byId.size,expected);
 assert.equal(openCount(),expected);
 const rooms=new Set([...byId.values()].map(p=>p.room));
 assert.equal(rooms.size,expected/2);
 for(const p of byId.values()){
  const g=currentState(p);
  assert.equal(g.server,'vip');
  assert.equal(g.maxPlayers,2);
  assert.equal(g.players.length,2);
  assert.ok(g.players.some(x=>x.id===p.id));
  assert.ok(g.players.every(x=>x.ticket===undefined&&x.issuedAt===undefined),'Ticket leaked in state');
  assert.ok(g.mapId>=1&&g.mapId<=5);
 }
 console.log('VIP_GAMEPLAY_STAGE '+JSON.stringify({clients:expected,rooms:rooms.size,open:openCount()}));
}
async function serverDiceAntiCheat(members){
 const state=currentState(members[0]);
 const initialSeq=state.actionSeq||0;
 const current=state.players[state.current]?.id;
 const player=members.find(p=>p.id===current);
 assert.ok(player,'No authorized current-turn player');
 // Deliberately malicious client fields must be ignored: dice is server-owned.
 player.socket.send(JSON.stringify({type:'roll',dice:999,score:999999}));
 await until(()=>members.every(x=>(currentState(x)?.actionSeq||0)>initialSeq),5000,'server dice confirmed');
 const next=currentState(members[0]);
 assert.ok(next.lastRoll>=1&&next.lastRoll<=6,'Dice was not server-generated');
 assert.equal(next.current,(state.current+1)%2);
 const seq=next.actionSeq;
 for(let i=0;i<5;i++)player.socket.send('{"type":"roll"}');
 await sleep(450);
 assert.ok(members.every(x=>(currentState(x)?.actionSeq||0)===seq),'Duplicate turn accepted');
 return {serverGeneratedDice:true,clientScoreIgnored:true,duplicateAttemptsRejected:5};
}
async function reconnect(room,session){
 const prior=room.members[1];
 const before=currentState(prior);
 assert.equal(before.status,'playing');
 assert.ok(before.turnEndsAt>Date.now()+6500,'Not enough turn budget for clean rejoin');
 assert.equal(room.pending,null,'Do not rotate a ticket during pending roll');
 prior.expected=4001;
 const booking=await call('/lab/match',{session,id:prior.id,server:'vip'});
 assert.equal(booking.rejoined,true,'Rejoin must retain existing seat');
 assert.equal(booking.room,room.members[0].room,'Rejoin created a different room');
 assert.equal(booking.maxPlayers,2);
 const next=await connect(booking,prior.id);
 await until(()=>currentState(next)?.status==='playing',4500,'replacement state');
 const state=currentState(next);
 assert.equal(state.turnEndsAt,before.turnEndsAt,'Reconnect extended 20s turn');
 assert.equal(state.actionSeq||0,before.actionSeq||0,'Reconnect changed turn sequence');
 assert.equal(state.roomId,booking.room);
 await until(()=>prior.code!==null,4500,'old socket revoked');
 assert.equal(prior.code,4001);
 const index=room.members.indexOf(prior);
 assert.ok(index>=0);
 room.members[index]=next;
 byId.set(prior.id,next);
 assert.equal(openCount(),CLIENT_LIMIT);
 return {seatRetained:true,oldSocketClosed4001:true,deadlineUnchanged:true,actionSequenceUnchanged:true};
}
function advanceOne(room,now){
 const states=room.members.map(currentState);
 assert.ok(states.every(Boolean),'Lost room state');
 const newest=states.reduce((a,b)=>(a.actionSeq||0)>=(b.actionSeq||0)?a:b);
 const seq=newest.actionSeq||0;
 assert.ok(states.every(s=>(s.actionSeq||0)>=seq-1),'Room states diverged');
 if(room.pending!==null){
  if(states.every(s=>(s.actionSeq||0)>room.pending)){
   assert.ok(newest.lastRoll>=1&&newest.lastRoll<=6,'Invalid server dice');
   room.confirmed+=seq-room.pending;
   room.pending=null;
  }else if(now-room.sentAt>5000)throw Error('Dice result not confirmed');
 }
 if(newest.status==='finished'){
  room.finished=true;
  assert.equal(room.pending,null,'Unconfirmed winning roll');
  return false;
 }
 assert.equal(newest.status,'playing','Active room left playing state unexpectedly');
 if(room.pending!==null||now<room.nextAt||newest.turnEndsAt<Date.now()+2500)return false;
 const current=newest.players[newest.current]?.id;
 const actor=room.members.find(p=>p.id===current);
 assert.equal(actor?.socket.readyState,WebSocket.OPEN,'Current player disconnected');
 room.pending=seq;room.sentAt=now;room.nextAt=now+ROLL_SPACING_MS;
 actor.socket.send('{"type":"roll","dice":99,"score":999999}');
 return true;
}
async function activeGame(rooms,session){
 const start=performance.now(),end=start+PLAY_MS;
 let reconnectResult=null,attempts=0,tick=0;
 while(performance.now()<end){
  ensure();
  const now=performance.now();
  if(!reconnectResult&&now-start>24000){
   const room=rooms[2];
   const state=currentState(room.members[1]);
   if(room.pending===null&&state?.turnEndsAt>Date.now()+8000){
    reconnectResult=await reconnect(room,session);
   }
  }
  assert.equal(openCount(),CLIENT_LIMIT,'VIP dropped during active gameplay');
  assert.equal(warnings.length,0,'Unexpected WebSocket during active gameplay');
  for(const room of rooms)if(advanceOne(room,performance.now()))attempts++;
  if(now-start>=tick*15000){
   console.log('VIP_GAMEPLAY_PROGRESS '+JSON.stringify({sec:Math.round((now-start)/1000),
    open:openCount(),rolls:rooms.reduce((n,r)=>n+r.confirmed,0)}));
   tick++;
  }
  await sleep(200);
 }
 await until(()=>rooms.every(room=>{
  if(room.pending===null)return true;
  const states=room.members.map(currentState);
  if(!states.every(s=>(s?.actionSeq||0)>room.pending))return false;
  assert.ok(states.every(s=>s.lastRoll>=1&&s.lastRoll<=6));
  room.confirmed+=Math.min(...states.map(s=>s.actionSeq||0))-room.pending;
  room.pending=null;return true;
 }),6500,'outstanding dice acknowledgements');
 const rolls=rooms.reduce((n,r)=>n+r.confirmed,0);
 assert.ok(rolls>=200,'Fewer than 200 server-confirmed VIP dice rolls');
 assert.ok(reconnectResult?.oldSocketClosed4001,'No verified ticket replacement');
 assert.equal(openCount(),CLIENT_LIMIT);
 return {seconds:Math.round((performance.now()-start)/1000),serverConfirmedRolls:rolls,
  attempts,open:openCount(),reconnect:reconnectResult};
}
async function idleRoomAndKeepOthersActive(rooms){
 const idle=rooms.find(r=>r.members.every(p=>currentState(p)?.status==='playing'));
 assert.ok(idle,'No active room for 3 missed-turn test');
 const peers=idle.members;
 for(const x of peers)x.expected=4003;
 const other=rooms.filter(r=>r!==idle);
 const start=performance.now(),untilAt=start+IDLE_MS;
 let sawShutdown=false,closedAfterMs=null,otherRollAttempts=0;
 while(performance.now()<untilAt){
  ensure();
  if(!sawShutdown){
   const states=peers.map(currentState);
   if(states.every(s=>s?.status==='abandoned'&&s.closeReason==='no_rolls_3_turns')){
    sawShutdown=true;closedAfterMs=Math.round(performance.now()-start);
   }
  }
  for(const room of other)if(advanceOne(room,performance.now()))otherRollAttempts++;
  assert.equal(warnings.length,0,'Unexpected close during idle-room phase');
  if(sawShutdown&&peers.every(e=>e.code===4003))break;
  await sleep(230);
 }
 await until(()=>peers.every(e=>e.code!==null),6000,'idle room close code');
 const latest=peers.map(currentState);
 assert.ok(latest.every(s=>s?.status==='abandoned'&&s.closeReason==='no_rolls_3_turns'));
 assert.ok(latest.every(s=>s.noRollTurns===3),'Three missed-turn rule changed');
 assert.ok(peers.every(p=>p.code===4003));
 assert.ok(other.flatMap(r=>r.members).every(x=>x.socket.readyState===WebSocket.OPEN));
 for(const room of other)if(room.pending!==null){
  await until(()=>room.members.every(x=>(currentState(x)?.actionSeq||0)>room.pending),
    5500,'remaining roll acknowledgements');
  room.pending=null;
 }
 return {missedTurns:3,reason:'no_rolls_3_turns',expectedCloseCode:4003,
  closedSockets:2,otherRooms:other.length,otherOpenClients:98,
  idleClosureAfterMs:closedAfterMs,rollAttemptsInOtherRooms:otherRollAttempts,
  totalConfirmedRolls:rooms.reduce((n,r)=>n+r.confirmed,0)};
}
try {
 const healthRes=await fetch(API+'/lab/health',{redirect:'error',signal:AbortSignal.timeout(9000)});
 assert.equal(healthRes.status,200);
 const health=await healthRes.json();
 assert.equal(health.isolated,true);
 assert.equal(health.enabled,true,'No prior Cloudflare operator approval');
 assert.equal(health.maxClients,CLIENT_LIMIT);
 assert.equal(health.gameDataConnected,false);
 assert.equal(health.paymentEnabled,false);
 assert.equal(health.realUserAuth,false);
 bearer=await gitHubIdentity();
 const init=await call('/lab/session',{});
 assert.equal(init.maxClients,CLIENT_LIMIT);
 const ids=Array.from({length:CLIENT_LIMIT},(_,i)=>'lab-'+(801+i));
 const stages=[];
 for(const target of STAGES){
  for(let i=byId.size;i<target;i+=PAIR_BATCH){
   const pair=await Promise.all(ids.slice(i,i+2).map(id=>admit(id,init.session)));
   for(const p of pair)byId.set(p.entry.id,p.entry);
   await sleep(45);
  }
  await checkStage(target);
  stages.push({clients:target,rooms:target/2,connected:openCount()});
 }
 const rooms=groupRooms();
 const antiCheat=await serverDiceAntiCheat(rooms[1].members);
 const game=await activeGame(rooms,init.session);
 const idle=await idleRoomAndKeepOthersActive(rooms);
 const status=await call('/lab/status');
 assert.equal(status.admitted,CLIENT_LIMIT);
 assert.equal(status.maxClients,CLIENT_LIMIT);
 assert.equal(openCount(),98);
 assert.equal(warnings.length,0);
 console.log('OIDC_VIP100_GAMEPLAY_RESULT '+JSON.stringify({
  verdict:'passed',stages,clients:CLIENT_LIMIT,rooms:ROOM_LIMIT,
  antiCheat,game,idle,totalSeconds:Math.round((performance.now()-origin)/1000),
  totalWebSocketInstances:all.length,publicIndependentRunner:true,
  realUsers:false,payments:false,sourceCodePrivateNotImported:true,
  requiresProviderAlarmAudit:true,clientHttpRequests:requests
 }));
}catch(e){
 console.error('OIDC_VIP100_GAMEPLAY_FAILED '+JSON.stringify({
  category:String(e?.message||e).slice(0,155),connected:openCount(),
  elapsedSeconds:Math.round((performance.now()-origin)/1000)
 }));
 process.exitCode=1;
}finally{
 clearTimeout(kill);
 for(const x of all)try{
  if(x.socket.readyState===WebSocket.OPEN)x.socket.close(1000,'synthetic cleanup');
  else if(x.socket.readyState!==WebSocket.CLOSED)x.socket.terminate();
 }catch{}
 await sleep(180);
 for(const x of all)try{x.socket.terminate()}catch{}
 bearer=null;
}
