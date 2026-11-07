#!/usr/bin/env node
// OFFLINE GAME MODEL ONLY. No Cloudflare, Firebase, WebSockets or network traffic.
// 10,000 model players != 10,000 proven real concurrent connections.
import {performance} from 'node:perf_hooks';
import {createGame,executeRoll,advance,randomInt} from '../public/rules.js';
const args=process.argv.slice(2);
function opt(name,def){const i=args.indexOf(name);return i<0?def:Number(args[i+1]);}
const players=opt('--players',10000),maxMoves=opt('--max-moves',300);
if(!Number.isInteger(players)||players<3||players>100000||!Number.isInteger(maxMoves)||maxMoves<1||maxMoves>10000){
 console.error('Usage: node tools/model-load.mjs --players 10000 --max-moves 300');process.exit(2);
}
const started=performance.now(),results={type:'offline-game-model',players,rooms:Math.ceil(players/3),
 finished:0,unfinished:0,rolls:0,boxesOpened:0,totalWinPoints:0,totalBoxPoints:0,
 boxPrizeCounts:{10:0,50:0,100:0,500:0,1000:0}};
for(let room=0;room<results.rooms;room++){
 const game=createGame('room-'+crypto.randomUUID());
 game.players=Array.from({length:3},(_,seat)=>({
   id:'sim-'+room+'-'+seat,name:'Simulation',pos:0,avatar:seat,shield:0,rewardX2:false
 }));
 game.status='playing';game.current=0;
 for(let n=0;n<maxMoves&&game.status==='playing';n++){
   const outcome=executeRoll(game,game.current,randomInt(6)+1);
   results.rolls++;
   if(outcome.reward!==null){results.boxesOpened++;results.totalBoxPoints+=outcome.reward;results.boxPrizeCounts[outcome.reward]++;}
   if(outcome.finished){results.finished++;results.totalWinPoints+=outcome.winPoints;}
   else advance(game);
 }
 if(game.status!=='finished')results.unfinished++;
}
results.elapsedMs=Number((performance.now()-started).toFixed(1));
results.heapMB=Number((process.memoryUsage().heapUsed/1024/1024).toFixed(1));
results.warning='Synthetic CPU simulation only. Never used as Cloudflare 10K live capacity proof.';
console.log(JSON.stringify(results,null,2));
