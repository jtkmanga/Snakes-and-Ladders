import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BOARD_MAPS,SNAKES,LADDERS,mapForGame,eligibleBoxes,createGame,executeRoll,roomCapacity} from './rules-v86.mjs';
const path=p=>fileURLToPath(new URL(p,import.meta.url));
const gameUI=readFileSync(path('./staging-game-v86.mjs'),'utf8');
const html=readFileSync(path('./game-index-v86.html'),'utf8');
const style=readFileSync(path('./game-style-v86.css'),'utf8');

test('five valid 100-tile maps with distinct snakes and ladders',()=>{
 assert.equal(BOARD_MAPS.length,5);
 assert.deepEqual(BOARD_MAPS.map(x=>x.id),[1,2,3,4,5]);
 const unique=new Set();
 for(const map of BOARD_MAPS){
  const heads=Object.keys(map.snakes).map(Number),feet=Object.keys(map.ladders).map(Number);
  assert.equal(heads.length,5);
  assert.ok(feet.length>=6);
  assert.equal(new Set([...heads,...feet]).size,heads.length+feet.length);
  for(const [from,to] of Object.entries(map.snakes)){
   assert.ok(Number.isInteger(Number(from))&&from>1&&from<100);
   assert.ok(Number.isInteger(to)&&to>=1&&to<from);
  }
  for(const [from,to] of Object.entries(map.ladders)){
   assert.ok(Number.isInteger(Number(from))&&from>=1&&from<100);
   assert.ok(Number.isInteger(to)&&to>from&&to<100);
  }
  const boxes=eligibleBoxes(map),specials=new Set([...heads,...feet,...Object.values(map.snakes),...Object.values(map.ladders)]);
  assert.ok(boxes.length>=60&&boxes.every(n=>n>=1&&n<=99&&!specials.has(n)));
  unique.add(JSON.stringify([map.snakes,map.ladders]));
 }
 assert.equal(unique.size,5);
});
test('legacy rooms without mapId preserve exact original board',()=>{
 assert.equal(mapForGame(null),BOARD_MAPS[0]);
 assert.equal(mapForGame({roomId:'old',server:'vip'}),BOARD_MAPS[0]);
 assert.deepEqual(SNAKES,BOARD_MAPS[0].snakes);
 assert.deepEqual(LADDERS,BOARD_MAPS[0].ladders);
 assert.equal(SNAKES[80],50);
 assert.equal(LADDERS[10],50);
});
test('each new room gets a valid random map, eligible Lucky Box, and Free/VIP capacities',()=>{
 const seen=new Set();
 for(let i=0;i<300;i++){
  const server=i%2?'vip':'free',g=createGame('room-'+i,server),map=mapForGame(g);
  assert.equal(g.mapId,map.id);
  assert.ok(eligibleBoxes(map).includes(g.boxAt));
  assert.equal(roomCapacity(g),server==='vip'?2:3);
  assert.equal(g.status,'waiting');
  seen.add(g.mapId);
 }
 assert.equal(seen.size,5);
});
test('dice use the selected map for every snake and ladder, including shield and win',()=>{
 for(const map of BOARD_MAPS){
  const make=(position,shield=0)=>({mapId:map.id,players:[{id:'p',name:'Tester',pos:position,shield,rewardX2:false}],boxAt:1,boxUsed:true,status:'playing',log:[],lastRoll:0});
  for(const [from,to] of Object.entries(map.snakes)){
   const step=executeRoll(make(Number(from)-1),0,1);
   assert.equal(step.to,to,'snake map '+map.id+' tile '+from);
   assert.equal(step.landing,Number(from));
  }
  for(const [from,to] of Object.entries(map.ladders)){
   const step=executeRoll(make(Number(from)-1),0,1);
   assert.equal(step.to,to,'ladder map '+map.id+' tile '+from);
   assert.equal(step.landing,Number(from));
  }
  const snake=Number(Object.keys(map.snakes)[0]),protectedGame=make(snake-1,1);
  executeRoll(protectedGame,0,1);
  assert.equal(protectedGame.players[0].pos,snake);
  assert.equal(protectedGame.players[0].shield,0);
  const winning=make(97);
  executeRoll(winning,0,6);
  assert.equal(winning.players[0].pos,100);
  assert.equal(winning.winnerId,'p');
 }
});
test('browser draws authoritative map and all five themes, while purchase UI remains',()=>{
 for(const filename of ['rules-v86.mjs','staging-game-v86.mjs']){
  const result=spawnSync(process.execPath,['--check',path('./'+filename)],{encoding:'utf8'});
  assert.equal(result.status,0,filename+': '+result.stderr);
 }
 assert.ok(gameUI.includes('const map=mapForGame(game)'));
 assert.ok(gameUI.includes('board.dataset.map=String(map.id)'));
 assert.ok(gameUI.includes('board.dataset.roomKey=mapRoomKey'));
 assert.ok(gameUI.includes('Object.entries(snakes)'));
 assert.ok(gameUI.includes('Object.entries(ladders)'));
 assert.ok(html.includes('id="board-map-name"'));
 assert.ok(html.includes('game.js?v=multi-map-v86'));
 assert.ok(html.includes('id="vip-buy"')&&!html.includes('id="payment-restore"'));
 for(let i=2;i<=5;i++)assert.ok(style.includes('.board[data-map="'+i+'"]'));
});
