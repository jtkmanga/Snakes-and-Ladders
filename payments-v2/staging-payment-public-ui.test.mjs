import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const jsPath=fileURLToPath(new URL('./staging-game-v69.mjs',import.meta.url));
const htmlPath=fileURLToPath(new URL('./staging-index-v69.html',import.meta.url));
const js=readFileSync(jsPath,'utf8'),html=readFileSync(htmlPath,'utf8');

test('deployed V69 client parses and loads as a JS module',()=>{
 const result=spawnSync(process.execPath,['--check',jsPath],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
test('payment test and trial buttons are completely removed',()=>{
 for(const tag of ['id="vip-demo-buy"','id="demo-v2-recent-auth"','id="payment-preview"','id="demo-v2-tools"','id="payment-preflight"','id="payment-start-preview"','data-buy-preview','id="trial-dice"','id="trial-shield"'])assert.ok(!html.includes(tag),tag);
 for(const code of ['createDemoBuyerOrderV2','simulateBuyerV2','listDemoBuyerOrdersV2','showPaymentPreview','activeDemoBuyerV2'])assert.ok(!js.includes(code),code);
});
test('all remaining checkout buttons have listener bindings',()=>{
 for(const id of ['vip-buy','payment-restore','payment-submit','payment-reconcile','payment-close'])assert.ok(html.includes('id="'+id+'"'),'missing '+id);
 assert.ok(js.includes("document.querySelectorAll('[data-buy]')"));
 assert.ok(js.includes("addEventListener('click',()=>buyProduct('vip'))"));
 assert.ok(js.includes('await loadPaymentQr(o.id)'));
 assert.ok(js.includes('/api/payments/v2/live/orders'));
});
test('no removed DOM reference can cause script initialisation to crash',()=>{
 for(const id of ['vip-demo-buy','demo-v2-tools','trial-dice','trial-shield','payment-preview','payment-preflight','payment-start-preview'])assert.ok(!js.includes("$('"+id+"')"),id);
 assert.ok(html.includes('game.js?v=payment-v2-69'));
});
