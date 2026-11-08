import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const gamePath=fileURLToPath(new URL('./staging-game-v62.mjs',import.meta.url));
const htmlPath=fileURLToPath(new URL('./staging-index-v62.html',import.meta.url));
const cssPath=fileURLToPath(new URL('./staging-style-v64.css',import.meta.url));
const game=readFileSync(gamePath,'utf8');
const html=readFileSync(htmlPath,'utf8');
const css=readFileSync(cssPath,'utf8');

test('live staging game module must parse without freezing Google login',()=>{
 const result=spawnSync(process.execPath,['--check',gamePath],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr||'node --check failed');
});
test('all demo buttons exist and match registered game listeners',()=>{
 for(const id of ['vip-demo-buy','demo-v2-recent-auth','demo-v2-tools','demo-v2-approved','demo-v2-reject','demo-v2-history','demo-v2-result','payment-panel-heading'])
  assert.ok(html.includes('id="'+id+'"'),'missing '+id);
 for(const sku of ['shield','win2'])assert.ok(html.includes('data-buy-preview="'+sku+'"'));
 for(const fn of ['createDemoBuyerOrderV2','simulateBuyerV2','listDemoBuyerOrdersV2'])
  assert.ok(game.includes('function '+fn+'('),'missing '+fn);
 assert.ok(game.includes("btn.dataset.buyPreview"),'demo buttons not bound');
});
test('demo purchase never creates a payable QR or calls old paid endpoints',()=>{
 const start=game.indexOf('async function createDemoBuyerOrderV2(');
 const end=game.indexOf('let activePaymentQrUrl=null;',start);
 assert.ok(start>=0&&end>start);
 const demo=game.slice(start,end);
 const openDemo=game.slice(game.indexOf('function showBuyerDemoV2Panel('),start);
 assert.ok(demo.includes('/api/payments/v2/demo-orders'));
 assert.ok(!demo.includes('loadPaymentQr('));
 assert.ok(!demo.includes('/api/orders/'));
 assert.ok(openDemo.includes("('payment-submit').disabled=true"));
 assert.ok(openDemo.includes("('payment-slip').disabled=true"));
 assert.ok(openDemo.includes('ไม่มี QR ที่สแกนจ่ายเงินจริง'));
 for(const real of ['data-buy="win2" type="button" disabled','data-buy="shield" type="button" disabled','id="vip-buy" type="button" disabled'])
  assert.ok(html.includes(real),'real purchase button unexpectedly enabled: '+real);
});
test('demo statuses are visibly distinct from real VIP entitlements',()=>{
 assert.ok(html.includes('DEMO ONLY'));
 assert.ok(html.includes('ไม่มีการรับเงินจริงหรือให้สิทธิ์ VIP'));
 assert.ok(game.includes('realBenefits')===false); // no real-benefit grant path in frontend
 assert.ok(game.includes('activeDemoBuyerV2'));
 assert.ok(game.includes('sim_fulfilled'));
 assert.ok(game.includes('ต้องเข้าสู่ระบบ Google'));
});

test('visible checkout panel is never unconditionally hidden by stylesheet',()=>{
 assert.ok(css.includes('#payment-panel[hidden]{display:none!important}'),'must hide while closed');
 assert.ok(css.includes('#payment-panel:not([hidden]){display:block!important;}'),'must show when open');
 assert.ok(!css.includes('#payment-panel,#payment-start-preview'),'must not hide checkout unconditionally');
 assert.ok(css.includes('[data-buy]'),'legacy real-money controls remain hidden');
});
