import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=n=>fileURLToPath(new URL(n,import.meta.url));
const main=readFileSync(file('./staging-main-v78.mjs'),'utf8');
const game=readFileSync(file('./staging-game-v78.mjs'),'utf8');
const ledger=readFileSync(file('./staging-ledger-v78.mjs'),'utf8');
const adminJs=readFileSync(file('./game-admin.js'),'utf8');
const adminHtml=readFileSync(file('./game-admin.html'),'utf8');

test('deployed V78 modules + dedicated Admin client pass JavaScript syntax parser',()=>{
 for(const name of ['staging-main-v78.mjs','staging-ledger-v78.mjs','staging-game-v78.mjs','game-admin.js']){
  const r=spawnSync(process.execPath,['--check',file('./'+name)],{encoding:'utf8'});
  assert.equal(r.status,0,name+': '+r.stderr);
 }
});
test('Admin endpoints use Firebase JWT identity, owner-only verified email, same-origin CSRF',()=>{
 assert.ok(main.includes("url.pathname.startsWith('/api/admin/board/')"));
 assert.ok(main.includes("if(!adminAllowed(user,env))return json({error:'ไม่มีสิทธิ์ใช้งาน Admin'},403)"));
 assert.ok(main.includes("if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403)"));
 assert.ok(main.includes('getAuthorizedUser(request,env)'));
 assert.ok(main.includes("url.pathname==='/api/admin/store/prices'"));
 assert.ok(main.includes("if(data?.confirm!=='RESET')"));
 assert.ok(adminJs.includes("api('/api/admin/session')"));
 assert.ok(adminHtml.includes('id="dashboard" hidden'));
});
test('remote payment prices come only from server registry and amount is pinned to order creation',()=>{
 assert.ok(ledger.includes('amountBaht:prices[sku]'));
 assert.ok(ledger.includes("this.ctx.storage.kv.put('admin:prices:v1',checked)"));
 assert.ok(main.includes("url.pathname==='/api/store/prices'"));
 assert.ok(main.includes('paid.getPricesV2()'));
 assert.ok(game.includes("fetch('/api/store/prices'"));
 assert.ok(game.includes("async function reloadStorePrices()"));
 assert.ok(main.includes('preflightBeforeMoney(env)'));
});
test('score resets are separated by Free and VIP, have alarms and protected score-edit API',()=>{
 assert.ok(main.includes('async alarm()'));
 assert.ok(main.includes('nextResetAt(now,server)'));
 assert.ok(main.includes("const server=body?.server"));
 assert.ok(main.includes("if(server==='vip'&&!await env.VIP"));
 assert.ok(main.includes("url.pathname==='/api/player/presence'"));
 assert.ok(game.includes('setInterval(sendPresence,30000)'));
 assert.ok(main.includes('async adminReset({server,actor})'));
 assert.ok(adminJs.includes("api('/api/admin/board/reset'"));
});
test('no payment demo UI restored, no full email updates allowed via Admin',()=>{
 assert.ok(!adminHtml.includes('type="email"'));
 assert.ok(!adminJs.includes('changeEmail'));
 assert.ok(adminHtml.includes('อีเมล Google แก้ไขไม่ได้'));
 assert.ok(!game.includes('createDemoBuyerOrderV2'));
});
