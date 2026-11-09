import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createGame,advance,roomCapacity,roomSizeForServer,TURN_MS} from './rules-v84.mjs';
const f=p=>fileURLToPath(new URL(p,import.meta.url));
const main=readFileSync(f('./staging-main-v84.mjs'),'utf8');
const browser=readFileSync(f('./staging-game-v84.mjs'),'utf8');
const html=readFileSync(f('./game-index-v84.html'),'utf8');

test('shared rules: VIP 2 seats, Free 3 seats, legacy room still 3 seats',()=>{
 assert.equal(roomSizeForServer('vip'),2);
 assert.equal(roomSizeForServer('free'),3);
 assert.equal(roomCapacity(createGame('room-free','free')),3);
 assert.equal(roomCapacity(createGame('room-vip','vip')),2);
 assert.equal(roomCapacity({server:'vip',players:[{},{}]}),3);
});
test('turns alternate between VIP 2 or rotate over Free 3 without changing 20s timer',()=>{
 const two=createGame('vip','vip');two.status='playing';two.players=[{id:'a'},{id:'b'}];
 const three=createGame('free','free');three.status='playing';three.players=[{id:'a'},{id:'b'},{id:'c'}];
 for(const [g,expected] of [[two,[1,0,1,0]],[three,[1,2,0,1]]]){
  for(const next of expected){advance(g,123456);assert.equal(g.current,next);assert.equal(g.turnEndsAt,123456+TURN_MS);}
 }
});
test('new worker and browser source syntax is valid',()=>{
 for(const name of ['rules-v84.mjs','staging-main-v84.mjs','staging-game-v84.mjs']){
  const r=spawnSync(process.execPath,['--check',f('./'+name)],{encoding:'utf8'});
  assert.equal(r.status,0,name+': '+r.stderr);
 }
});
test('Lobby separates Free and VIP queues and caps new VIP queue at 2',()=>{
 assert.ok(main.includes('env.LOBBY.idFromName(\`lobby-\${server}-v1\`)'));
 assert.ok(main.includes('waiting.count>=(waiting.maxPlayers||3)'));
 assert.ok(main.includes('maxPlayers:roomSizeForServer(profile.server)'));
 assert.ok(main.includes('maxPlayers:renewed.maxPlayers,rejoined:true'));
 assert.ok(main.includes('maxPlayers:accepted.maxPlayers'));
 assert.ok(main.includes("if(server==='vip'&&!await vip().hasAccess(user.id))"));
});
test('Room reserves to frozen capacity; connects and times out to actual players count',()=>{
 assert.ok(main.includes('createGame(roomId,profile.server)'));
 assert.ok(main.includes('game.players.length>=roomCapacity(game)'));
 assert.ok(main.includes('game.players.length===roomCapacity(game)&&this.activeIds().length===roomCapacity(game)'));
 assert.ok(main.includes('game.current=(game.current+1)%game.players.length'));
 assert.ok(main.includes('maxPlayers:roomCapacity(game)'));
 assert.ok(main.includes("this.env.SCORES.idFromName(`scores-${game.server||'free'}-v1`)"));
});
test('game UI clearly displays 2 VIP, 3 Free and current room capacity',()=>{
 assert.ok(html.includes('🎮 จับคู่ห้องละ 2 คน'));
 assert.ok(html.includes('🎮 จับคู่ห้องละ 3 คน'));
 assert.ok(html.includes('id="lobby-room-size"'));
 assert.ok(html.includes('game.js?v=vip-pair-v84'));
 assert.ok(browser.includes('roomSizeForServer(selectedServer)'));
 assert.ok(browser.includes('roomCapacity(game)-game.players.length'));
 assert.ok(browser.includes('roomCapacity(game)-(game.connected||[]).length'));
 assert.ok(browser.includes('data.maxPlayers||roomSizeForServer(selectedServer)'));
 assert.ok(!browser.includes('Array.from({length:3-game.players.length}'));
 assert.ok(!browser.includes("game.status==='waiting'?'รอผู้เล่นครบ 3 คน'"));
});
test('VIP membership and payment protection are unchanged',()=>{
 assert.ok(main.includes('paymentRolloutAllowed'));
 assert.ok(main.includes("if(server==='vip'&&!await vip().hasAccess(user.id))"));
 assert.ok(html.includes('id="vip-buy"'));
 assert.ok(!html.includes('id="payment-restore"'));
 assert.ok(!html.includes('menu-admin-link'));
});
