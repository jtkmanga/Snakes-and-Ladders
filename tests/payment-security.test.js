import test from 'node:test';
import assert from 'node:assert/strict';
import {PRODUCTS,paymentConfigured,validateSlipResponse,transferFingerprint} from '../src/payments.js';
import {verifyFirebaseToken} from '../src/security.js';
const good=()=>({code:'200200',data:{amount:100,transRef:'bank-transaction-12345',decode:'00112233445566778899',dateTime:new Date().toISOString()}});
test('product prices fixed in backend (VIP, win×2, shield)',()=>{
  assert.deepEqual([PRODUCTS.vip.amount,PRODUCTS.win2.amount,PRODUCTS.shield.amount],[100,20,10]);
  assert.equal(Object.isFrozen(PRODUCTS),true);
});
test('payments always start disabled and require exact merchant config',()=>{
  assert.equal(paymentConfigured({PAYMENTS_ENABLED:'false'}),false);
  assert.equal(paymentConfigured({PAYMENTS_ENABLED:'true'}),false);
  assert.equal(paymentConfigured({PAYMENTS_ENABLED:'true',SLIP2GO_SECRET:'test',SLIP2GO_API_BASE_URL:'https://api.slip2go.com/',MERCHANT_ACCOUNT_TYPE:'02001',MERCHANT_ACCOUNT_NUMBER:'0812345678',MERCHANT_DISPLAY_NAME:'Test'}),true);
  assert.equal(paymentConfigured({PAYMENTS_ENABLED:'true',SLIP2GO_SECRET:'test',SLIP2GO_API_BASE_URL:'https://api.slip2go.com/',MERCHANT_ACCOUNT_TYPE:'02001',MERCHANT_ACCOUNT_NUMBER:'081234567',MERCHANT_DISPLAY_NAME:'Test'}),false);
  assert.equal(paymentConfigured({PAYMENTS_ENABLED:'true',SLIP2GO_SECRET:'test',SLIP2GO_API_BASE_URL:'https://api.slip2go.com/',MERCHANT_ACCOUNT_TYPE:'01004',MERCHANT_ACCOUNT_NUMBER:'0812345678',MERCHANT_DISPLAY_NAME:'Test'}),false);
});
test('verified transfer must have provider success code, QR, reference, amount and recent timestamp',()=>{
  assert.equal(validateSlipResponse(good(),100).amount,100);
  for(const code of ['200000','200401','200402','200501','200500','401005']){
    assert.throws(()=>validateSlipResponse({...good(),code},100));
  }
  assert.throws(()=>validateSlipResponse(good(),20));
  assert.throws(()=>validateSlipResponse({...good(),data:{...good().data,decode:''}},100));
  assert.throws(()=>validateSlipResponse({...good(),data:{...good().data,dateTime:new Date(Date.now()-60*60*1000).toISOString()}},100));
});
test('stable one-way transaction fingerprint changes with bank reference or QR',async()=>{
  const a=await transferFingerprint({reference:'abc',qr:'1234567890'});
  assert.equal(a.length,64);
  assert.equal(a,await transferFingerprint({reference:'abc',qr:'1234567890'}));
  assert.notEqual(a,await transferFingerprint({reference:'abc',qr:'ABCDEFGHIJ'}));
});
test('invalid/unsigned/HS256 Firebase ID tokens are rejected',async()=>{
  await assert.rejects(verifyFirebaseToken('x.y.z','testproject'));
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  await assert.rejects(verifyFirebaseToken(encode({alg:'HS256',kid:'x'})+'.'+encode({sub:'abc'})+'.x','testproject'));
});
