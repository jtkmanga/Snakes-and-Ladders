#!/usr/bin/env node
/**
 * ORIGINAL PUBLIC SYNTHETIC-ONLY RUNNER: no private source imports.
 * Single manual GitHub OIDC job to exercise the isolated V99 Load Lab's
 * empty VIP-room Alarm at 100 synthetic clients / 50 rooms.
 * It does not test real VIP payment, Google accounts, private scores or Admin.
 */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {setTimeout as delay} from 'node:timers/promises';

const HOST='snakes-and-ladders-game-loadlab.jtkmanga.workers.dev';
const ROOT='https://'+HOST,WS='wss://'+HOST;
const AUDIENCE=ROOT+'/oidc/v1';
const MAX_CLIENTS=100,MAX_ROOMS=50,MAX_RUN_MS=190000;
const IDLE_ALARM_MS=80000;
const MAX_BATCH=10;
assert.equal(process.argv.length,2,'No arguments or endpoint overrides permitted');
assert.equal(process.env.GITHUB_REPOSITORY,'jtkmanga/Snakes-and-Ladders');
assert.equal(process.env.GITHUB_REF,'refs/heads/main');
assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
assert.equal(process.env.RUN_ISOLATED_VIP100_ALARM,'confirmed-manual-100');
const started=Date.now();
const clients=[];
let watchdogExpired=false,liveToken=null;
const watchdog=setTimeout(()=>{
 watchdogExpired=true;
 for(const x of clients)try{x.ws.terminate()}catch{}
},MAX_RUN_MS);
function guard(){
 assert.equal(watchdogExpired,false,'Global hard deadline exceeded');
 assert.ok(Date.now()-started<MAX_RUN_MS,'Test duration exceeded');
}
async function identity(){
 const url=process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
 const runtimeBearer=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
 assert.ok(typeof url==='string'&&url.startsWith('https://'),'Missing GitHub OIDC endpoint');
 assert.ok(typeof runtimeBearer==='string'&&runtimeBearer.length>10,'Missing runtime OIDC capability');
 const target=new URL(url);
 target.searchParams.set('audience',AUDIENCE);
 const r=await fetch(target,{
  headers:{Authorization:'Bearer '+runtimeBearer},redirect:'error',
  signal:AbortSignal.timeout(10000)
 });
 assert.equal(r.status,200,'OIDC issuance failed');
 const data=await r.json();
 assert.ok(typeof data.value==='string'&&data.value.length>128&&data.value.length<8192);
 return data.value;
}
async function api(path,post){
 guard();
 const r=await fetch(ROOT+path,{
  method:post===undefined?'GET':'POST',
  headers:{Authorization:'Bearer '+liveToken,...(post===undefined?{}:{'Content-Type':'application/json'})},
  ...(post===undefined?{}:{body:JSON.stringify(post)}),
  redirect:'error',signal:AbortSignal.timeout(11000)
 });
 assert.equal(r.ok,true,'Lab endpoint denied '+path+' HTTP '+r.status);
 return r.json();
}
async function socket(booking){
 guard();
 assert.ok(clients.length<MAX_CLIENTS,'More than 100 WebSocket instances');
 return new Promise((resolve,reject)=>{
  const u=WS+'/lab/ws?room='+encodeURIComponent(booking.room)+'&ticket='+encodeURIComponent(booking.ticket);
  const ws=new WebSocket(u,{headers:{Authorization:'Bearer '+liveToken},handshakeTimeout:9000});
  const entry={ws,room:booking.room,playing:false,closeCode:null,hasError:false};
  clients.push(entry);
  let ready=false;
  const failTimer=setTimeout(()=>failed('WS_upgrade_timeout'),9000);
  function failed(reason){if(ready)return;ready=true;clearTimeout(failTimer);reject(Error(reason))}
  ws.on('open',()=>{if(ready)return;ready=true;clearTimeout(failTimer);resolve(entry)});
  ws.on('message',raw=>{
   try {
    const m=JSON.parse(String(raw));
    if(m.type==='state'&&m.state?.status==='playing'&&m.state?.maxPlayers===2
      &&Array.isArray(m.state.players)&&m.state.players.length===2){
      entry.playing=true;
    }
   }catch{}
  });
  ws.on('close',code=>{entry.closeCode=code;if(!ready)failed('WS_early_close')});
  ws.on('error',()=>{entry.hasError=true;if(!ready)failed('WS_error')});
  ws.on('unexpected-response',(_,r)=>{r.resume();failed('WS_HTTP_'+r.statusCode)});
 });
}
async function until(check,ms,what){
 const end=Date.now()+ms;
 while(Date.now()<end){guard();if(check())return;await delay(75)}
 throw Error('Timeout '+what);
}
try{
 // Anonymous health ONLY; must require a separate short-lived operator
 // activation. A signed token alone never arms the Lab.
 const h=await fetch(ROOT+'/lab/health',{redirect:'error',signal:AbortSignal.timeout(10000)});
 assert.equal(h.status,200);
 const health=await h.json();
 assert.equal(health.isolated,true);
 assert.equal(health.enabled,true,'Lab must be explicitly activated with automatic expiry');
 assert.equal(health.maxClients,MAX_CLIENTS);
 assert.equal(health.gameDataConnected,false);
 assert.equal(health.paymentEnabled,false);
 assert.equal(health.realUserAuth,false);
 liveToken=await identity();
 const session=await api('/lab/session',{});
 assert.equal(session.maxClients,MAX_CLIENTS);
 const ids=Array.from({length:MAX_CLIENTS},(_,i)=>'lab-'+(601+i));
 const bookings=[];
 for(let i=0;i<MAX_CLIENTS;i+=MAX_BATCH){
  const chunk=ids.slice(i,i+MAX_BATCH);
  const b=await Promise.all(chunk.map(id=>api('/lab/match',{session:session.session,id,server:'vip'})));
  for(let j=0;j<b.length;j++){
   assert.equal(b[j].playerId,chunk[j]);
   assert.equal(b[j].maxPlayers,2);
   assert.match(b[j].room,/^room-[0-9a-f-]{36}$/);
  }
  bookings.push(...b);
  await Promise.all(b.map(socket));
  assert.ok(clients.length<=MAX_CLIENTS);
 }
 assert.equal(bookings.length,MAX_CLIENTS);
 const rooms=new Map();
 for(const b of bookings)rooms.set(b.room,(rooms.get(b.room)||0)+1);
 assert.equal(rooms.size,MAX_ROOMS,'Must allocate exactly 50 VIP rooms');
 assert.ok([...rooms.values()].every(n=>n===2),'Every VIP room must have exactly two seats');
 await until(()=>clients.every(x=>x.playing),8000,'100 players in active rooms');
 assert.ok(clients.every(x=>x.ws.readyState===WebSocket.OPEN),'Lost active client before close');

 // Target the historical post-run anomaly: all clients exit cleanly while
 // scheduled room Alarms remain pending. Never send rolls or alter scores.
 for(const c of clients)c.ws.close(1000,'synthetic clean exit');
 await until(()=>clients.every(x=>x.closeCode!==null),15000,'all normal exits');
 assert.ok(clients.every(x=>x.closeCode===1000),'Unexpected voluntary close code');
 assert.ok(clients.every(x=>!x.hasError),'WebSocket error before cleanup');
 const closeAt=Date.now();
 await delay(IDLE_ALARM_MS);
 guard();
 assert.equal(clients.filter(x=>x.ws.readyState===WebSocket.CLOSED).length,MAX_CLIENTS);
 console.log('OIDC_VIP100_EMPTY_ROOM_RESULT '+JSON.stringify({
  verdict:'passed',syntheticClients:MAX_CLIENTS,vipRooms:MAX_ROOMS,
  normalCloses:MAX_CLIENTS,alarmObservationMs:Date.now()-closeAt,
  totalElapsedMs:Date.now()-started,privateCodeImported:false,
  realUsers:false,payments:false,
  providerAlarmMetricsRequireSeparateReview:true
 }));
}catch(error){
 console.error('OIDC_VIP100_EMPTY_ROOM_FAILED '+String(error?.message||error).slice(0,150));
 process.exitCode=1;
}finally{
 clearTimeout(watchdog);
 for(const c of clients){try{
  if(c.ws.readyState===WebSocket.OPEN)c.ws.close(1000,'cleanup');
  else if(c.ws.readyState!==WebSocket.CLOSED)c.ws.terminate();
 }catch{}}
 await delay(200);
 for(const c of clients)try{c.ws.terminate()}catch{}
 liveToken=null;
}
