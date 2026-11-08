// Shared game rules imported by both browser demo and Cloudflare Worker.
export const SNAKES = Object.freeze({80:50,94:68,59:31,37:17,98:76});
export const LADDERS = Object.freeze({10:50,65:85,4:25,28:53,42:61,72:91});
export const AVATARS = Object.freeze([
  {name:'แมว',emoji:'🐱'},{name:'กระต่าย',emoji:'🐰'},{name:'จิ้งจอก',emoji:'🦊'},
  {name:'หมี',emoji:'🐻'},{name:'แพนด้า',emoji:'🐼'},{name:'กบ',emoji:'🐸'},
  {name:'เพนกวิน',emoji:'🐧'},{name:'ลูกเจี๊ยบ',emoji:'🐥'},
  {name:'สุนัข',emoji:'🐶'},{name:'ยูนิคอร์น',emoji:'🦄'}
]);
export const TURN_MS = 20_000;
export const WIN_POINTS = 10;
export const VIP_LIMIT = 100;
// The room capacity is fixed at reservation time; legacy rooms without maxPlayers remain 3-player rooms.
export const roomSizeForServer=server=>server==='vip'?2:3;
export const roomCapacity=game=>game?.maxPlayers===2||game?.maxPlayers===3?game.maxPlayers:3;
export const VIP_DAYS = 30;
export const VIP_DURATION_MS = VIP_DAYS * 86_400_000;
// Winner-only multiplier. Never applies to dice steps or Lucky Box.
export function winnerPoints(player){return WIN_POINTS * (player?.rewardX2 === true ? 2 : 1);}
// Board animation passes through each number, then glides on snake/ladder if any.
export function movementPath(from, landing, to){
  const path=[];
  for(let n=from+1;n<=landing;n++)path.push(n);
  if(to!==landing)path.push(to);
  return path;
}
// Probabilities in units of one tenth of one percent: exactly 1000/1000.
// Weighted selection is server-controlled in online play and cryptographically random.
export const LUCKY_PRIZES = Object.freeze([
  Object.freeze({points:10, weight:500, chance:'50%'}),
  Object.freeze({points:50, weight:300, chance:'30%'}),
  Object.freeze({points:100, weight:190, chance:'19%'}),
  Object.freeze({points:500, weight:9, chance:'0.9%'}),
  Object.freeze({points:1000, weight:1, chance:'0.1%'})
]);
export function drawLuckyPoints(ticket=randomInt(1000)){
  if(!Number.isInteger(ticket)||ticket<0||ticket>=1000)throw new RangeError('ticket must be 0–999');
  for(const prize of LUCKY_PRIZES){
    if(ticket<prize.weight)return prize.points;
    ticket-=prize.weight;
  }
  throw new Error('Lucky Box probabilities must total 100%');
}
export function eligibleBoxes(){
  const special=new Set([...Object.keys(SNAKES),...Object.keys(LADDERS),...Object.values(SNAKES),...Object.values(LADDERS)].map(Number));
  return Array.from({length:99},(_,i)=>i+1).filter(n=>!special.has(n));
}
export function randomInt(max){
  // Uniform rejection sampling. Server controls the real game dice.
  const limit=Math.floor(0x100000000/max)*max;
  const arr=new Uint32Array(1); let num;
  do{crypto.getRandomValues(arr);num=arr[0];}while(num>=limit);
  return num%max;
}
export function createGame(roomId,server='free'){
  const possible=eligibleBoxes();
  const maxPlayers=roomSizeForServer(server);
  return {roomId,maxPlayers,players:[],status:'waiting',current:0,turnEndsAt:0,
    boxAt:possible[randomInt(possible.length)],boxUsed:false,boxReward:null,boxWinnerId:null,prizeCredited:false,
    lastRoll:0,winnerId:null,credited:false,log:[`กำลังรอผู้เล่นครบ ${maxPlayers} คน…`]};
}
export function executeRoll(game,playerIndex,dice){
  const player=game.players[playerIndex];
  const before=player.pos;
  if(!Number.isInteger(dice)||dice<1||dice>6)throw new RangeError('ลูกเต๋าต้องเป็นเลข 1–6');
  const steps=dice;
  let msg=`${player.name} ทอยได้ ${dice} แต้ม`;
  let reward=null;
  const landing=Math.min(100,before+steps);
  // Reaching or passing the finish line wins; never bounce back or wait for an exact roll.
  if(before+steps>=100){
    player.pos=100;
    if(before+steps>100)msg+=' 🏁 ถึงเส้นชัยแล้ว (แต้มเกิน 100 ก็ชนะ)';
  }else{
    player.pos=before+steps;
    // Box only opens on a direct dice landing, not by passing its tile or using a ladder.
    if(!game.boxUsed && player.pos===game.boxAt){
      game.boxUsed=true;
      reward=drawLuckyPoints();
      game.boxReward=reward;
      game.boxWinnerId=player.id;
      game.prizeCredited=false;
      player.bonusPoints=(player.bonusPoints||0)+reward;
      msg+=` 🎁 Lucky Box ได้รับ ${reward.toLocaleString('th-TH')} คะแนน!`;
    }
    if(SNAKES[player.pos]){
      if(player.shield>0){player.shield--;msg+=' 🛡️ ป้องกันงูได้!';}
      else{player.pos=SNAKES[player.pos];msg+=` 🐍 ลงมาช่อง ${player.pos}`;}
    }else if(LADDERS[player.pos]){
      player.pos=LADDERS[player.pos];msg+=` 🪜 ขึ้นบันไดไปช่อง ${player.pos}`;
    }
  }
  game.lastRoll=dice;
  game.lastMove=steps;
  if(player.pos===100){game.status='finished';game.winnerId=player.id;game.winPoints=winnerPoints(player);msg+=` 🏆 ชนะเกม รับ ${game.winPoints} คะแนน!`;}
  game.actionSeq=(game.actionSeq||0)+1;
  game.lastAction={seq:game.actionSeq,playerId:player.id,from:before,landing,to:player.pos,dice};
  game.log=[msg,...game.log].slice(0,5);
  return {from:before,landing,to:player.pos,dice,steps,path:movementPath(before,landing,player.pos),reward,winPoints:game.status==='finished'?game.winPoints:0,finished:game.status==='finished'};
}
export function advance(game,now=Date.now()){
  if(game.status!=='playing')return;
  game.current=(game.current+1)%game.players.length;
  game.turnEndsAt=now+TURN_MS;
}
