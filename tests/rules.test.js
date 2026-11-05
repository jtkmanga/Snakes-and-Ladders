import test from 'node:test';
import assert from 'node:assert/strict';
import {SNAKES,LADDERS,LUCKY_PRIZES,drawLuckyPoints,eligibleBoxes,createGame,executeRoll,advance,TURN_MS,winnerPoints,movementPath,VIP_LIMIT} from '../public/rules.js';

function makeGame(position=0,boxAt=44){
 const g=createGame('room-example');
 g.players=[{id:'p0',name:'นักแข่ง',pos:position,avatar:0,shield:0,bonusPoints:0},
 {id:'p1',name:'บอท',pos:0,avatar:1,shield:0,bonusPoints:0},
 {id:'p2',name:'บอท2',pos:0,avatar:2,shield:0,bonusPoints:0}];
 g.boxAt=boxAt;g.status='playing';return g;
}
test('chest position is within 1..99 and avoids snake/ladder cells',()=>{
 assert(eligibleBoxes().length>0);
 for(const n of eligibleBoxes()){
  assert(n>=1&&n<=99);
  assert.equal(SNAKES[n],undefined);
  assert.equal(LADDERS[n],undefined);
 }
});
test('takes snake 80 to 50',()=>{
 const g=makeGame(78);executeRoll(g,0,2);assert.equal(g.players[0].pos,50);
});
test('takes ladder 10 to 50',()=>{
 const g=makeGame(9);executeRoll(g,0,1);assert.equal(g.players[0].pos,50);
});
test('exact 100 wins',()=>{
 const g=makeGame(97);const r=executeRoll(g,0,3);
 assert.equal(r.to,100);assert.equal(r.finished,true);assert.equal(g.winnerId,'p0');
});
test('overshoot 97 + 5 goes straight to 100 and wins',()=>{
 const g=makeGame(97);const r=executeRoll(g,0,5);
 assert.equal(r.to,100);assert.equal(g.players[0].pos,100);assert.equal(g.status,'finished');
});
test('overshoot 99 + 6 goes straight to 100 and wins',()=>{
 const g=makeGame(99);executeRoll(g,0,6);
 assert.equal(g.players[0].pos,100);assert.equal(g.winnerId,'p0');
});
test('reward x2 does not double movement and 90 + 3 stays at 93',()=>{
 const g=makeGame(90);g.players[0].rewardX2=true;
 const r=executeRoll(g,0,3);
 assert.equal(r.steps,3);assert.equal(r.to,93);assert.equal(r.finished,false);
});
test('Lucky Box listed probabilities add up to 1000 weight units',()=>{
 assert.deepEqual(LUCKY_PRIZES.map(p=>[p.points,p.weight,p.chance]),[[10,500,'50%'],[50,300,'30%'],[100,190,'19%'],[500,9,'0.9%'],[1000,1,'0.1%']]);
 assert.equal(LUCKY_PRIZES.reduce((t,p)=>t+p.weight,0),1000);
});
test('Lucky Box prize mapping yields exact 50/30/19/.9/.1 weights',()=>{
 const counts=new Map();
 for(let ticket=0;ticket<1000;ticket++){
  const score=drawLuckyPoints(ticket);
  counts.set(score,(counts.get(score)||0)+1);
 }
 assert.deepEqual([...counts.entries()],[[10,500],[50,300],[100,190],[500,9],[1000,1]]);
});
test('Lucky Box boundary values including 1000-point jackpot',()=>{
 assert.equal(drawLuckyPoints(0),10);assert.equal(drawLuckyPoints(499),10);
 assert.equal(drawLuckyPoints(500),50);assert.equal(drawLuckyPoints(799),50);
 assert.equal(drawLuckyPoints(800),100);assert.equal(drawLuckyPoints(989),100);
 assert.equal(drawLuckyPoints(990),500);assert.equal(drawLuckyPoints(998),500);
 assert.equal(drawLuckyPoints(999),1000);
 assert.throws(()=>drawLuckyPoints(1000),RangeError);
});
test('Lucky Box awards score once and stores recipient and result',()=>{
 const g=makeGame(42,44);
 const r=executeRoll(g,0,2);
 assert.equal(g.boxUsed,true);
 assert.equal(g.boxWinnerId,'p0');
 assert.equal(g.boxReward,r.reward);
 assert([10,50,100,500,1000].includes(r.reward));
 assert.equal(g.players[0].bonusPoints,r.reward);
 assert.equal(g.prizeCredited,false);
 g.players[1].pos=43;
 const r2=executeRoll(g,1,1);
 assert.equal(r2.reward,null);
 assert.equal(g.players[1].bonusPoints,0);
});
test('passing Lucky Box without landing cannot open it',()=>{
 const g=makeGame(41,44);
 executeRoll(g,0,6);
 assert.equal(g.boxUsed,false);
});
test('shield blocks exactly one snake',()=>{
 const g=makeGame(79);g.players[0].shield=1;
 executeRoll(g,0,1);assert.equal(g.players[0].pos,80);assert.equal(g.players[0].shield,0);
 g.players[0].pos=79;executeRoll(g,0,1);assert.equal(g.players[0].pos,50);
});
test('advance goes to next of 3 with full 20s',()=>{
 const g=makeGame();advance(g,100000);assert.equal(g.current,1);assert.equal(g.turnEndsAt,100000+TURN_MS);
});
test('reward x2 keeps die range and normal movement',()=>{
 const g=makeGame(11,44);g.players[0].rewardX2=true;
 const outcome=executeRoll(g,0,4);
 assert.equal(outcome.dice,4);assert.equal(outcome.steps,4);assert.equal(g.players[0].pos,15);
});
test('invalid die results rejected',()=>{
 const g=makeGame();assert.throws(()=>executeRoll(g,0,7),RangeError);
});

test('reward x2 doubles only winner points from 10 to 20',()=>{
 const g=makeGame(97);g.players[0].rewardX2=true;
 const result=executeRoll(g,0,5);
 assert.equal(result.to,100);assert.equal(result.winPoints,20);assert.equal(g.winPoints,20);
 assert.equal(winnerPoints({rewardX2:false}),10);
});
test('reward x2 never multiplies Lucky Box reward',()=>{
 const g=makeGame(42,44);g.players[0].rewardX2=true;
 const r=executeRoll(g,0,2);
 assert.equal(g.boxReward,r.reward);assert.equal(g.players[0].bonusPoints,r.reward);
});
test('movement path visits every intermediate tile before snake/ladder glide',()=>{
 assert.deepEqual(movementPath(77,80,50),[78,79,80,50]);
 assert.deepEqual(movementPath(9,10,50),[10,50]);
 assert.deepEqual(movementPath(97,100,100),[98,99,100]);
});
test('VIP member cap is exactly 100',()=>{assert.equal(VIP_LIMIT,100);});
