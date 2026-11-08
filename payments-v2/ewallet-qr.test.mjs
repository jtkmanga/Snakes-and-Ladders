import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEWalletPromptPayPayload,validateEWalletId,crc16CcittFalse} from './ewallet-qr.mjs';
const DUMMY_EWALLET_ID='123456789012345';
test('15 digit E-Wallet ID accepted; phone number and other forms rejected',()=>{
 assert.equal(validateEWalletId(DUMMY_EWALLET_ID),true);
 for(const id of ['0812345678','12345678901234','1234567890123456','123-456789012345','',undefined,1])
   assert.equal(validateEWalletId(id),false);
});
test('QR encodes wallet in EMV Tag 29 / inner Tag 03 and exact amount',()=>{
 const q=buildEWalletPromptPayPayload({accountNumber:DUMMY_EWALLET_ID,amountBaht:100});
 assert.ok(q.includes('0016A0000006770101110315'+DUMMY_EWALLET_ID));
 assert.ok(q.includes('5406100.00'));
 assert.ok(q.includes('5303764'));
 assert.ok(q.includes('5802TH'));
 assert.ok(q.endsWith(crc16CcittFalse(q.slice(0,-4))));
 assert.ok(q.startsWith('00020101021229'));
});
test('changing amount changes checksum and QR; never reuse a static QR',()=>{
 const a=buildEWalletPromptPayPayload({accountNumber:DUMMY_EWALLET_ID,amountBaht:10});
 const b=buildEWalletPromptPayPayload({accountNumber:DUMMY_EWALLET_ID,amountBaht:20});
 assert.notEqual(a,b);
 assert.ok(a.includes('540510.00'));
 assert.ok(b.includes('540520.00'));
});
test('invalid amounts never produce QR',()=>{
 for(const amountBaht of [-1,0,1.5,100001,Infinity,NaN,'100',null]){
  assert.throws(()=>buildEWalletPromptPayPayload({accountNumber:DUMMY_EWALLET_ID,amountBaht}));
 }
});
test('never accept an unverified wallet identifier or phone-number receiver',()=>{
 for(const id of ['00000000000000','abcdefghijklmno','0612345678']){
  assert.throws(()=>buildEWalletPromptPayPayload({accountNumber:id,amountBaht:10}));
 }
});
