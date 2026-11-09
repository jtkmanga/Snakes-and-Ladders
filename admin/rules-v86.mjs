// Shared game rules imported by both browser demo and Cloudflare Worker.
// These five layouts are immutable and shared by the Worker and browser.
// Map 1 preserves the original board so rooms created before this update remain unchanged.
export const BOARD_MAPS=Object.freeze([
  Object.freeze({id:1,name:'🌿 สวนมรกต',snakes:Object.freeze({80:50,94:68,59:31,37:17,98:76}),ladders:Object.freeze({10:50,65:85,4:25,28:53,42:61,72:91})}),
  Object.freeze({id:2,name:'🎋 ป่าไผ่',snakes:Object.freeze({23:8,47:26,63:41,79:55,95:70}),ladders:Object.freeze({3:22,15:39,31:49,51:76,68:89,84:97})}),
  Object.freeze({id:3,name:'🏯 วิหารโบราณ',snakes:Object.freeze({29:11,44:19,66:38,81:57,97:73}),ladders:Object.freeze({6:27,17:36,33:58,46:67,62:88,75:93})}),
  Object.freeze({id:4,name:'🐚 อ่าวปะการัง',snakes:Object.freeze({26:9,49:27,70:43,86:59,99:74}),ladders:Object.freeze({8:30,18:42,35:54,50:72,64:83,77:96})}),
  Object.freeze({id:5,name:'☁️ เมืองเมฆ',snakes:Object.freeze({34:14,52:28,73:45,88:61,96:78}),ladders:Object.freeze({2:19,13:32,25:48,40:65,57:81,69:92})})
]);
export const SNAKES=BOARD_MAPS[0].snakes;
export const LADDERS=BOARD_MAPS[0].ladders;
export const mapForGame=game=>BOARD_MAPS.find(map=>map.id===game?.mapId)||BOARD_MAPS[0];
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
export function eligibleBoxes(map=BOARD_MAPS[0]){
  const {snakes,ladders}=map;
  const special=new Set([...Object.keys(snakes),...Object.keys(ladders),...Object.values(snakes),...Object.values(ladders)].map(Number));
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
  // A new room samples one of five maps server-side. The selected map never changes mid-game.
  const map=BOARD_MAPS[randomInt(BOARD_MAPS.length)];
  const possible=eligibleBoxes(map);
  const maxPlayers=roomSizeForServer(server);
  return {roomId,mapId:map.id,maxPlayers,players:[],status:'waiting',current:0,turnEndsAt:0,
    boxAt:possible[randomInt(possible.length)],boxUsed:false,boxReward:null,boxWinnerId:null,prizeCredited:false,
    lastRoll:0,winnerId:null,credited:false,log:[`กำลังรอผู้เล่นครบ ${maxPlayers} คน…`]};
}
export function executeRoll(game,playerIndex,dice){
  const player=game.players[playerIndex];
  const before=player.pos;
  if(!Number.isInteger(dice)||dice<1||dice>6)throw new RangeError('ลูกเต๋าต้องเป็นเลข 1–6');
  const steps=dice;
  const {snakes,ladders}=mapForGame(game);
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
    if(snakes[player.pos]){
      if(player.shield>0){player.shield--;msg+=' 🛡️ ป้องกันงูได้!';}
      else{player.pos=snakes[player.pos];msg+=` 🐍 ลงมาช่อง ${player.pos}`;}
    }else if(ladders[player.pos]){
      player.pos=ladders[player.pos];msg+=` 🪜 ขึ้นบันไดไปช่อง ${player.pos}`;
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
