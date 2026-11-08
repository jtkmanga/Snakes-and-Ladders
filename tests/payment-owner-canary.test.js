import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {paymentConfigured,paymentPublicEnabled,paymentRolloutAllowed} from '../src/payments.js';
const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/game.js',import.meta.url),'utf8');

function env(rollout){
 return {
  PAYMENTS_ENABLED:'true',
  SLIP2GO_SECRET:'synthetic-only',SLIP2GO_API_BASE_URL:'https://connect.slip2go.com/',
  MERCHANT_ACCOUNT_TYPE:'02001',MERCHANT_ACCOUNT_NUMBER:'0812345678',MERCHANT_DISPLAY_NAME:'Lucky Game',
  ADMIN_EMAIL:'owner@example.invalid',
  ...(rollout?{PAYMENT_ROLLOUT:rollout}:{})
 };
}
const owner={id:'uid-owner',email:'OWNER@EXAMPLE.INVALID'};
const other={id:'uid-player',email:'other@example.invalid'};

test('payment rollout defaults to owner-only even after enabling merchant configuration',()=>{
 const e=env();
 assert.equal(paymentConfigured(e),true);
 assert.equal(paymentPublicEnabled(e),false);
 assert.equal(paymentRolloutAllowed(e,owner),true);
 assert.equal(paymentRolloutAllowed(e,other),false);
 assert.equal(paymentRolloutAllowed(e,{email:owner.email}),false);
 assert.equal(paymentRolloutAllowed({...e,PAYMENTS_ENABLED:'false'},other),false);
});
test('explicit public setting is required to grant purchases to regular players',()=>{
 assert.equal(paymentPublicEnabled(env('canary')),false);
 assert.equal(paymentRolloutAllowed(env('canary'),other),false);
 assert.equal(paymentPublicEnabled(env('public')),true);
 assert.equal(paymentRolloutAllowed(env('public'),other),true);
 assert.equal(paymentRolloutAllowed(env('disabled'),owner),false);
});
test('the Worker enforces rollout on order, QR generation and slip verification',()=>{
 assert.match(worker,/if\(!paymentRolloutAllowed\(env,user\)\)return json\(\{error:'เปิดทดสอบชำระเงินเฉพาะบัญชีเจ้าของเกม'\},403\)/);
 assert.equal((worker.match(/paymentRolloutAllowed\(env,user\)/g)||[]).length,4);
 assert.match(worker,/canPurchase:paymentConfigured\(env\)&&paymentRolloutAllowed\(env,user\)/);
 assert.match(worker,/paymentsEnabled:paymentPublicEnabled\(env\)/);
});
test('the browser only enables pay controls when the server authorizes the current user',()=>{
 assert.match(ui,/const permitted=Boolean\(publicConfig\?\.paymentsEnabled\|\|serverMe\?\.canPurchase\)/);
 assert.match(ui,/if\(!publicConfig\?\.paymentsEnabled&&!serverMe\?\.canPurchase\)/);
 assert.match(ui,/updatePaymentPurchaseAccess\(\)/);
});
