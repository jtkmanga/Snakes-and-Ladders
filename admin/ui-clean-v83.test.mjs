import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=p=>fileURLToPath(new URL(p,import.meta.url));
const html=readFileSync(file('./game-index-v83.html'),'utf8');
const game=readFileSync(file('./staging-game-v83.mjs'),'utf8');
const worker=readFileSync(file('./staging-main-v82.mjs'),'utf8');
test('Remove only the requested in-game navigation controls',()=>{
 assert.ok(!html.includes('id="payment-restore"'));
 assert.ok(!html.includes('ตรวจคำสั่งซื้อเดิม / กู้คืนสิทธิ์'));
 assert.ok(!html.includes('menu-admin-link'));
 assert.ok(!html.includes('ระบบหลังบ้าน Admin'));
 assert.ok(!game.includes("$('payment-restore')"));
 assert.ok(html.includes('id="vip-buy"'));
 assert.ok(html.includes('id="payment-panel"'));
 assert.ok(html.includes('id="payment-submit"'));
 assert.ok(html.includes('id="online-top-status"'));
 assert.ok(html.includes('src="./game.js?v=ui-clean-v83"'));
});
test('Game script still parses, and purchase verification remains operational',()=>{
 const result=spawnSync(process.execPath,['--check',file('./staging-game-v83.mjs')],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.ok(game.includes('async function restoreLastPayment(')||game.includes('function restoreLastPayment('));
 assert.ok(game.includes("$('payment-submit').addEventListener('click',submitSlip)"));
 assert.ok(game.includes("$('vip-buy').addEventListener('click',()=>buyProduct('vip'))"));
});
test('Free/VIP matchmaking is isolated at Durable Object queue ID',()=>{
 assert.ok(worker.includes("const server=body?.server==='vip'?'vip':body?.server==='free'?'free':null;"));
 assert.ok(worker.includes("env.LOBBY.idFromName("+"\`lobby-\${server}-v1\`"+")"));
 assert.ok(worker.includes("if(server==='vip'&&!await vip().hasAccess(user.id))"));
});
