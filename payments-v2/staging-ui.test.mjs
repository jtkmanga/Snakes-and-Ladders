import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const gamePath=fileURLToPath(new URL('./staging-game-v68.mjs',import.meta.url));
const htmlPath=fileURLToPath(new URL('./staging-index-v68.html',import.meta.url));
const cssPath=fileURLToPath(new URL('./staging-style-v68.css',import.meta.url));
const mainPath=fileURLToPath(new URL('./staging-main-v68.mjs',import.meta.url));
const ledgerPath=fileURLToPath(new URL('./staging-ledger-v66.mjs',import.meta.url));
const game=readFileSync(gamePath,'utf8');
const html=readFileSync(htmlPath,'utf8');
const css=readFileSync(cssPath,'utf8');
const main=readFileSync(mainPath,'utf8');
const ledger=readFileSync(ledgerPath,'utf8');

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
 assert.ok(!css.includes('[data-buy],.store-price'),'purchase controls must not be blank-hidden');
 assert.ok(html.includes('data-buy="shield" type="button" disabled'));
 assert.ok(html.includes('data-buy="win2" type="button" disabled'));
});

test('deployed Worker main and DO ledgers must parse as modules',()=>{
 for(const path of [mainPath,ledgerPath]){
  const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr||'node --check failed');
 }
});
test('V66 buyer integration uses V2 routes exclusively and retains Stage 5 server guard',()=>{
 assert.ok(game.includes('/api/payments/v2/live/orders'));
 assert.ok(game.includes('/api/payments/v2/demo-orders'));
 assert.ok(!game.includes("authorizedFetch('/api/orders',{method:'POST'"));
 assert.ok(!game.includes('/api/orders/recent'));
 assert.ok(main.includes('V2_STAGE5_ORDER_ROUTES'));
 assert.ok(main.includes('liveCheckoutOpen(env,buyer)'));
 assert.ok(main.includes("reason:guard.reason"));
 assert.ok(main.includes('PAYMENT_REBUILD_V2_DISABLED'));
 assert.ok(ledger.includes('PaymentV2LiveCoordinator'));
 assert.ok(html.includes('game.js?v=payment-v2-68'));
 assert.ok(html.includes('style.css?v=payment-v2-68'));
});

test('verified and fulfilling V2 orders must reconcile without generating a second QR',()=>{
 const begin=game.indexOf('async function buyProduct(sku){');
 const end=game.indexOf('async function submitSlip(){',begin);
 assert.ok(begin>=0&&end>begin);
 const buy=game.slice(begin,end);
 assert.ok(buy.includes("o.status==='verified'||o.status==='fulfilling'"));
 assert.ok(buy.includes("$('payment-reconcile').hidden=false"));
 assert.ok(buy.includes("o.status==='pending'&&Date.now()<o.expiresAt"));
 assert.ok(buy.includes('await loadPaymentQr(o.id)'));
 assert.ok(game.includes('order.status===\'fulfilling\''));
});

test('V68 client config hard-locks real checkout while exposing safe product prices',()=>{
 assert.ok(main.includes('paymentV2Stage5Locked:V2_STAGE5_LOCKED'));
 assert.ok(main.includes('paymentsEnabled:paymentPublicEnabled(env)&&!V2_STAGE5_LOCKED'));
 assert.ok(game.includes('publicConfig?.paymentV2Stage5Locked!==true'));
 assert.ok(game.includes('publicConfig?.paymentV2Stage5Locked===true'));
 assert.ok(!css.includes('#payment-panel,#payment-start-preview'));
 assert.ok(html.includes('vip-demo-buy'));
});
