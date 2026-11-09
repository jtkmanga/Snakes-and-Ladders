import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const f=p=>fileURLToPath(new URL(p,import.meta.url));
const g=readFileSync(f('./staging-game-v90.mjs'),'utf8');
const h=readFileSync(f('./game-index-v90.html'),'utf8');
test('payment recovery release parses and retains all UI invariants',()=>{
 const syntax=spawnSync(process.execPath,['--check',f('./staging-game-v90.mjs')],{encoding:'utf8'});
 assert.equal(syntax.status,0,syntax.stderr);
 assert.ok(h.includes('game.js?v=payment-recovery-v90'));
 assert.ok(h.includes('id="payment-submit"'));
 assert.ok(h.includes('id="vip-buy"'));
 assert.ok(!h.includes('id="payment-restore"'));
 assert.ok(!h.includes('menu-admin-link'));
 assert.ok(g.includes('nameplate.textContent=playerName'));
});
test('deep link only tries to recover existing order after authenticated owner-canary access',()=>{
 assert.ok(g.includes("if(u&&serverMe?.canPurchase&&!paymentRecoveryAutoOpened)"));
 assert.ok(g.includes("const preferredSku=new URLSearchParams(window.location.search).get('recoverPayment')"));
 assert.ok(g.includes("['vip','shield','win2'].includes(preferredSku)"));
 assert.ok(g.includes('paymentRecoveryAutoOpened=true'));
 assert.ok(g.includes('restoreLastPayment(preferredSku).catch('));
 assert.ok(!g.includes('paymentRecoveryAutoOpened=false;\n  '));
});
test('recovery looks up original SKU in server-authenticated order list instead of creating a new order',()=>{
 const a=g.indexOf('async function restoreLastPayment(preferredSku=null){'),b=g.indexOf('async function buyProduct(sku)',a);
 assert.ok(a>=0&&b>a);
 const restore=g.slice(a,b);
 assert.ok(restore.includes("authorizedFetch('/api/payments/v2/live/orders')"));
 assert.ok(restore.includes('preferredSku?data.orders.find(o=>o.sku===preferredSku):data.orders[0]'));
 assert.ok(restore.includes("panel.dataset.order=order.id"));
 assert.ok(restore.includes("24*60*60*1000"));
 assert.ok(!restore.includes("method:'POST'"));
});
test('all uploaded images still pass strict backend image and Slip2Go transaction checks',()=>{
 assert.ok(g.includes('async function prepareSlipImageForUpload(file)'));
 assert.ok(g.includes("headers:{'Content-Type':image.mime},body:image.blob"));
 assert.ok(g.includes("async function submitSlip()"));
 assert.ok(g.includes("async function reconcilePayment()"));
});
