import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {allowedCanaryItem,validateMerchantReadiness,preflightBeforeMoney} from '../src/payment-canary.js';
import {verifySlip,RECEIPT_RECOVERY_MS} from '../src/payments.js';

const env={
  PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'canary',
  MERCHANT_DISPLAY_NAME:'Lucky Game',MERCHANT_ACCOUNT_TYPE:'02001',
  MERCHANT_ACCOUNT_NUMBER:'0812345678',
  SLIP2GO_SECRET:'synthetic-key',SLIP2GO_API_BASE_URL:'https://connect.slip2go.com/'
};
const now=Date.now();
const account=()=>({
  shopName:'Lucky Game',package:'BASIC',packageExpiredDate:new Date(now+7*86_400_000).toISOString(),
  tokenRemaining:347,tokenPerSlip:.25,creditRemaining:0,checkSlipByCredit:false
});
const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const ledger=readFileSync(new URL('../src/ledger.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/game.js',import.meta.url),'utf8');

test('owner-only live canary permits shield at THB 10 only',()=>{
  assert.equal(allowedCanaryItem(env,'shield'),true);
  assert.equal(allowedCanaryItem(env,'win2'),false);
  assert.equal(allowedCanaryItem(env,'vip'),false);
  assert.equal(allowedCanaryItem({...env,PAYMENT_ROLLOUT:'public'},'vip'),true);
  assert.equal(allowedCanaryItem(env,'nonsense'),false);
  assert.match(worker,/if\(!allowedCanaryItem\(env,body\.sku\)\)/);
  assert.equal((worker.match(/allowedCanaryItem\(env,current\.sku\)/g)||[]).length,2);
  assert.match(ui,/btn\.dataset\.buy!=='shield'/);
  assert.match(ui,/\$\('vip-buy'\)\.disabled=!permitted\|\|canaryOnly/);
});

test('merchant preflight refuses mismatched shops, expired packages and exhausted quota',()=>{
  assert.deepEqual(validateMerchantReadiness(account(),env,now),{ok:true});
  assert.equal(validateMerchantReadiness({...account(),shopName:'Another Shop'},env,now).reason,'merchant_name_mismatch');
  assert.equal(validateMerchantReadiness({...account(),packageExpiredDate:new Date(now-100).toISOString()},env,now).reason,'merchant_package_expired_or_unknown');
  assert.equal(validateMerchantReadiness({...account(),packageExpiredDate:null},env,now).reason,'merchant_package_expired_or_unknown');
  assert.equal(validateMerchantReadiness({...account(),tokenRemaining:0},env,now).reason,'merchant_no_verification_quota');
  assert.equal(validateMerchantReadiness({...account(),tokenRemaining:0,creditRemaining:10,checkSlipByCredit:true},env,now).ok,true);
});

test('a successful live canary requires read-only Slip2Go account verification before QR/order creation',async()=>{
  let count=0;
  const result=await preflightBeforeMoney(env,async(url,options)=>{
    count++;
    assert.equal(url,'https://connect.slip2go.com/api/account/info');
    assert.equal(options.method,'GET');
    assert.equal(options.headers.Authorization,env.SLIP2GO_SECRET);
    assert.equal(options.body,undefined);
    return Response.json({code:'200001',data:account()});
  });
  assert.equal(count,1);assert.equal(result.ok,true);
  assert.match(worker,/const check=await preflightBeforeMoney\(env\)/);
  assert.match(worker,/ledger\(\)\.hasPreviousPaid\(user\.id\)/);
  assert.match(ledger,/SELECT COUNT\(\*\) AS total FROM orders WHERE uid=\? AND status IN \('verified','fulfilled'\)/);
});

test('no QR can be created if the provider preflight fails or the shop is wrong',async()=>{
  await assert.rejects(preflightBeforeMoney(env,async()=>{
    throw Error('NETWORK_PRIVATE_DETAILS');
  }),e=>!e.message.includes('NETWORK_PRIVATE_DETAILS'));
  const result=await preflightBeforeMoney(env,async()=>Response.json({
    code:'200001',data:{...account(),shopName:'Unknown shop'}
  }));
  assert.equal(result.ok,false);
  assert.equal(result.reason,'merchant_name_mismatch');
  assert.match(worker,/ยังไม่สามารถตรวจความพร้อม Slip2Go จึงไม่สร้าง QR รับเงิน/);
});

test('a bank transfer made during the 15m QR window remains verifiable on delayed upload, not later transfers',async()=>{
  assert.equal(RECEIPT_RECOVERY_MS,24*60*60*1000);
  const oldFetch=globalThis.fetch;
  const created=Date.now()-60*60*1000,expires=created+15*60*1000;
  let transferDate=created+2*60*1000;
  globalThis.fetch=async()=>Response.json({
    code:'200200',data:{amount:10,transRef:'CONFIRMED-BANK-TRANSFER',dateTime:new Date(transferDate).toISOString()}
  });
  const file=new Blob([new Uint8Array(200)],{type:'image/png'});
  const order={createdAt:created,expiresAt:expires,amount:10};
  try{
    const receipt=await verifySlip(file,order,env);
    assert.equal(receipt.amount,10);
    transferDate=expires+4*60*1000;
    await assert.rejects(verifySlip(file,order,env),/สลิปโอนหลังคำสั่งซื้อหมดอายุ/);
    await assert.rejects(verifySlip(file,{...order,createdAt:Date.now()-25*60*60*1000},env),/หมดเวลาส่งสลิป/);
  }finally{globalThis.fetch=oldFetch;}
  assert.match(ledger,/order\.created_at\+RECEIPT_RECOVERY_MS/);
});
