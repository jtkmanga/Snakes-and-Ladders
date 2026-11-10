#!/usr/bin/env node
/**
 * Verify the REAL, hash-pinned Cloudflare V99 pure rules module with synthetic
 * in-memory game state. No login, payments, websocket, DB writes, or source export.
 * Only enabled manually/nightly after read-only CF secrets are configured.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const SCRIPT='snakes-and-ladders-staging';
const EXPECTED_VERSION='69c8e428-cd8c-4106-be91-ccc00cdf3e1e';
const EXPECTED_RULES_SHA256='2d6494d81183fbabf9df58e89086e9502e652cdead040f8719a4d01be40a6772';
const {CF_ACCOUNT_ID,CF_API_TOKEN}=process.env;
if(!CF_API_TOKEN||!CF_ACCOUNT_ID){
  console.log('SKIP: deployed-rules tests need CF_API_TOKEN and CF_ACCOUNT_ID with read-only content access');
  process.exit(0);
}
assert.match(CF_ACCOUNT_ID,/^[a-f\d]{32}$/i);
const api=`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${SCRIPT}`;
async function fetchFromCloudflare(url){
  const res=await fetch(url,{headers:{Authorization:`Bearer ${CF_API_TOKEN}`},
    redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw Error(`Cloudflare source read HTTP ${res.status}`);
  return res;
}
const status=await (await fetchFromCloudflare(api+'/deployments')).json();
assert.equal(status.success,true);
assert.equal(status.result?.deployments?.[0]?.versions?.[0]?.version_id,
  EXPECTED_VERSION,'Deployed version changed; verify and repin before trusting tests');
const response=await fetchFromCloudflare(api);
assert.match(response.headers.get('content-type')||'',/multipart\/form-data/);
const form=await response.formData();
const file=form.get('rules.js');
assert.ok(file&&typeof file.text==='function','Deployed rules.js missing');
const source=await file.text();
const digest=createHash('sha256').update(source).digest('hex');
assert.equal(digest,EXPECTED_RULES_SHA256,'Source hash changed; refuse unreviewed code execution');
// Remove API credentials from process environment before loading code.
delete process.env.CF_API_TOKEN;
delete process.env.CF_ACCOUNT_ID;
// Source was verified against a pinned hash and contains no imports/dependencies.
// Imported directly from memory: no source files or customer data written to disk.
const rules=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

let passed=0;
const check=(title,run)=>{
  try{assert.equal(run(),true,title);console.log('PASS '+title);passed++;}
  catch(error){console.error('FAIL '+title+' '+String(error?.message||error));process.exitCode=1;}
};
const fixture=(pos,mapId=1,overrides={})=>({
  roomId:'synthetic-only',mapId,boxAt:6,boxUsed:true,
  players:[{id:'synthetic-a',name:'Test A',pos,shield:0,rewardX2:false,...overrides}],
  status:'playing',log:['synthetic'],current:0
});

check('five distinct immutable maps',()=>rules.BOARD_MAPS.length===5&&
  new Set(rules.BOARD_MAPS.map(m=>m.id)).size===5&&rules.BOARD_MAPS.every(Object.isFrozen));
check('each board has 5 snakes and 6 ladders',()=>rules.BOARD_MAPS.every(m=>
  Object.keys(m.snakes).length===5&&Object.keys(m.ladders).length===6));
check('snakes descend and ladders ascend',()=>rules.BOARD_MAPS.every(m=>
  Object.entries(m.snakes).every(([a,b])=>+a>b)&&
  Object.entries(m.ladders).every(([a,b])=>+a<b)));
check('no overlap of snake heads and ladder starts',()=>rules.BOARD_MAPS.every(m=>
  new Set([...Object.keys(m.snakes),...Object.keys(m.ladders)]).size===11));
check('VIP 2 / Free 3 and VIP registration cap 100',()=>rules.roomSizeForServer('vip')===2&&
  rules.roomSizeForServer('free')===3&&rules.VIP_LIMIT===100);
check('20-second turn and 10 avatars',()=>rules.TURN_MS===20000&&rules.AVATARS.length===10);
check('winning ×2 changes only winner points',()=>rules.winnerPoints({rewardX2:true})===20&&
  rules.winnerPoints({rewardX2:false})===10);
check('Lucky Box weights sum to 100%',()=>rules.LUCKY_PRIZES.reduce((s,x)=>s+x.weight,0)===1000);
check('Lucky Box reward boundaries',()=>[
  [0,10],[499,10],[500,50],[799,50],[800,100],[989,100],[990,500],[998,500],[999,1000]
].every(([ticket,reward])=>rules.drawLuckyPoints(ticket)===reward));
check('Lucky Box tickets outside 0..999 rejected',()=>{
  for(const ticket of [-1,1000,2.5]){
    let threw=false;try{rules.drawLuckyPoints(ticket)}catch(e){threw=e instanceof RangeError}
    if(!threw)return false;
  }
  return true;
});
check('Lucky Box locations exclude all snake/ladder endpoints',()=>rules.BOARD_MAPS.every(m=>{
  const reserved=new Set([...Object.keys(m.snakes),...Object.keys(m.ladders),
    ...Object.values(m.snakes),...Object.values(m.ladders)].map(Number));
  return rules.eligibleBoxes(m).every(n=>n>=1&&n<100&&!reserved.has(n));
}));
check('finish line permits dice overshoot',()=>{
  const game=fixture(97);const result=rules.executeRoll(game,0,6);
  return result.finished&&game.players[0].pos===100&&game.winPoints===10;
});
check('winner ×2 yields exactly 20 at finish',()=>{
  const game=fixture(99,1,{rewardX2:true});rules.executeRoll(game,0,3);
  return game.players[0].pos===100&&game.winPoints===20;
});
check('shield consumes one charge on snake collision',()=>{
  const game=fixture(79,1,{shield:1});rules.executeRoll(game,0,1);
  return game.players[0].pos===80&&game.players[0].shield===0;
});
check('snake without shield sends player down',()=>{
  const game=fixture(79);rules.executeRoll(game,0,1);
  return game.players[0].pos===50;
});
check('ladder sends player up with gradual movement path',()=>{
  const game=fixture(9);const result=rules.executeRoll(game,0,1);
  return game.players[0].pos===50&&result.path.join(',')==='10,50';
});
check('Lucky Box reward is not multiplied by win ×2',()=>{
  const game=fixture(5,1,{rewardX2:true});game.boxUsed=false;
  const result=rules.executeRoll(game,0,1);
  return result.reward!==null&&game.players[0].bonusPoints===result.reward&&
    result.winPoints===0&&game.boxUsed;
});
check('ladder cannot indirectly trigger a Lucky Box',()=>{
  const game=fixture(9);game.boxAt=50;game.boxUsed=false;
  rules.executeRoll(game,0,1);
  return game.boxUsed===false&&game.players[0].pos===50;
});
check('invalid dice are rejected',()=>{
  const game=fixture(0);
  try{rules.executeRoll(game,0,7);return false}catch(e){return e instanceof RangeError}
});
check('turn advance rotates players and counts exactly 20s',()=>{
  const game=fixture(0);
  game.players.push({id:'synthetic-b',name:'Test B',pos:0,shield:0});
  rules.advance(game,500);
  return game.current===1&&game.turnEndsAt===20500;
});
check('new VIP rooms use allowed maps and box tiles',()=>{
  const game=rules.createGame('synthetic-room','vip');
  const map=rules.BOARD_MAPS.find(x=>x.id===game.mapId);
  return game.maxPlayers===2&&Boolean(map)&&rules.eligibleBoxes(map).includes(game.boxAt);
});
console.log(JSON.stringify({source:'deployed V99 rules.js',sha256:digest,passed,total:21,
  writes:false,livePayments:false,logins:false}));
if(passed!==21)process.exitCode=1;
