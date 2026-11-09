import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const read=name=>readFileSync(fileURLToPath(new URL(name,import.meta.url)),'utf8');
const game=read('./staging-game-v74.mjs');
const html=read('./staging-index-v74.html');
const css=read('./staging-style-v73.css');
const backend=read('./staging-main-v73.mjs');
const admin=read('./staging-admin-v73.html');

test('V73 game and backend scripts parse, no syntax regressions',()=>{
 for(const file of ['staging-game-v74.mjs','staging-main-v73.mjs']){
  const p=fileURLToPath(new URL('./'+file,import.meta.url));
  const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});
  assert.equal(r.status,0,file+': '+r.stderr);
 }
});
test('clicking any of 3 buy buttons opens actual payment dialog before awaiting QR',()=>{
 assert.ok(html.includes('id="vip-buy"'));
 assert.ok(html.includes('data-buy="shield"'));
 assert.ok(html.includes('data-buy="win2"'));
 assert.ok(html.includes('id="payment-panel" hidden role="dialog"'));
 assert.ok(html.includes('aria-modal="true"'));
 assert.ok(html.includes('id="payment-dismiss"'));
 assert.ok(game.includes('function openPaymentDialog()'));
 assert.ok(game.includes('function closePaymentDialog()'));
 const buy=game.slice(game.indexOf('async function buyProduct(sku){'),game.indexOf('async function submitSlip(){'));
 assert.ok(buy.indexOf('openPaymentDialog();')>=0);
 assert.ok(buy.indexOf('openPaymentDialog();')<buy.indexOf('await authorizedFetch('));
 assert.ok(buy.includes('await loadPaymentQr(o.id)'));
 assert.ok(buy.includes('ตรวจชื่อบัญชีผู้รับและยอด'));
 assert.ok(game.includes("addEventListener('click',()=>buyProduct('vip'))"));
 assert.ok(game.includes("document.querySelectorAll('[data-buy]')"));
 assert.ok(css.includes('z-index:80!important'));
 assert.ok(css.includes('.payment-dialog'));
 assert.ok(css.includes('body.payment-open'));
 assert.ok(html.includes('game.js?v=payment-v2-74'));
});
test('authenticated owner can see and buy all three products, only server emits payable QR',()=>{
 const updated=game.slice(game.indexOf('function updatePaymentPurchaseAccess(){'),game.indexOf('async function initializeOnlineServices(){'));
 assert.ok(updated.includes("button.disabled=!allowed"));
 assert.ok(updated.includes("('vip-buy').disabled=!allowed"));
 assert.ok(!updated.includes("dataset.buy!=='shield'"));
 assert.ok(backend.includes("if(!adminAllowed(buyer,env))return json({error:'Owner canary only'},403)"));
 assert.ok(backend.includes('liveCheckoutOpen(env,buyer)'));
 assert.ok(!backend.includes('Canary only supports 10 THB shield'));
 const live=backend.slice(backend.indexOf('V2_STAGE5_ORDER_ROUTES'),backend.indexOf('V2_GAME_BUYER_PREVIEW'));
 assert.equal((live.match(/preflightBeforeMoney\(env\)/g)||[]).length,2);
 assert.ok(live.includes("['shield','win2','vip']"));
 assert.ok(backend.includes('paymentV2Stage5Locked:V2_STAGE5_LOCKED'));
});
test('staging contains only real payment controls; no mock payment buttons',()=>{
 for(const bad of ['id="vip-demo-buy"','id="payment-preview"','id="demo-v2-tools"','data-buy-preview','id="trial-dice"','id="trial-shield"'])
  assert.ok(!html.includes(bad),bad);
 assert.ok(html.includes('id="payment-submit"'));
 assert.ok(html.includes('id="payment-restore"'));
 assert.ok(html.includes('id="payment-reconcile"'));
 assert.ok(admin.includes('VIP 100 บาท, เกราะกันงู 10 บาท'));
 assert.ok(!admin.includes('id="simulate-401002"'));
});

test('V74 disables slip resubmission after verified result and shows non-payable loading state',()=>{
 const submit=game.slice(game.indexOf('async function submitSlip(){'),game.indexOf('async function reconcilePayment(){'));
 assert.ok(submit.includes('let confirmed=false;'));
 assert.ok(submit.includes('confirmed=true;'));
 assert.ok(submit.includes("finally{$('payment-submit').disabled=confirmed;$('payment-slip').disabled=confirmed;}"));
 const buy=game.slice(game.indexOf('async function buyProduct(sku){'),game.indexOf('async function submitSlip(){'));
 assert.ok(buy.includes('กำลังสร้าง QR ตามยอดคำสั่งซื้อ'));
 assert.ok(buy.includes('โปรดอย่าโอนก่อน QR ปรากฏ'));
 assert.ok(buy.includes('ยังไม่มี QR ที่ชำระได้ • อย่าโอนเงิน'));
});
