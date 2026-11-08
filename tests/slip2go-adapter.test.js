import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentConfigured,paymentReadiness,providerEndpoint,verifySlip} from '../src/payments.js';

const env=()=>({
 PAYMENTS_ENABLED:'false',SLIP2GO_SECRET:'mock-secret-never-real',
 SLIP2GO_API_BASE_URL:'https://connect.slip2go.com/',
 MERCHANT_ACCOUNT_TYPE:'02001',MERCHANT_ACCOUNT_NUMBER:'0812345678',MERCHANT_DISPLAY_NAME:'Lucky Game'
});
const makeFile=()=>new Blob([new Uint8Array(200)],{type:'image/png'});
const order=()=>({amount:100,createdAt:Date.now()-30000,expiresAt:Date.now()+600000});
const result=code=>({code,data:{
 amount:100,transRef:'BANK-ABC-00000001',decode:'0041000600000101030040220014242082547BPM049885102TH9104',
 dateTime:new Date().toISOString()
}});

test('staging is fail-closed even with all other payment configuration available',()=>{
 const e=env();
 assert.equal(paymentConfigured(e),false);
 assert.deepEqual(paymentReadiness(e),{
  enabled:false,apiOriginConfigured:true,receiverConfigured:true,secretConfigured:true,merchantConfigured:true,ready:false
 });
 e.SLIP2GO_API_BASE_URL='';
 assert.equal(paymentReadiness(e).apiOriginConfigured,false);
 assert.equal(paymentConfigured({...e,PAYMENTS_ENABLED:'true'}),false);
 assert.deepEqual(paymentReadiness({...e}).receiverConfigured,true);
});

test('untrusted or malformed API origins cannot activate payment',()=>{
 const e=env();e.PAYMENTS_ENABLED='true';
 for(const url of ['http://connect.slip2go.com/','https://connect.slip2go.com.evil.example/','https://api.slip2go.com/',
   'https://evil.example/','https://slip2go.com@evil.example/',
   'https://connect.slip2go.com:8443/','https://connect.slip2go.com/path',
   'https://connect.slip2go.com/?mode=on']){
   e.SLIP2GO_API_BASE_URL=url;
   assert.equal(paymentConfigured(e),false,url);
   assert.throws(()=>providerEndpoint(e),undefined,url);
 }
 e.SLIP2GO_API_BASE_URL='https://connect.slip2go.com/';
 assert.equal(providerEndpoint(e),'https://connect.slip2go.com/api/verify-slip/qr-image/info');
 assert.equal(paymentConfigured(e),true);
});

test('mocked Slip2Go adapter sends correct multipart checks and exact server order amount',async()=>{
 const e=env();e.PAYMENTS_ENABLED='true';
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,opts)=>{
  calls++;
  assert.equal(url,'https://connect.slip2go.com/api/verify-slip/qr-image/info');
  assert.equal(opts.method,'POST');
  assert.equal(opts.headers.Authorization,e.SLIP2GO_SECRET);
  assert.equal(opts.body.has('file'),true);
  const payload=JSON.parse(opts.body.get('payload'));
  assert.equal(payload.checkDuplicate,true);
  assert.deepEqual(payload.checkReceiver,[{accountType:'02001',accountNumber:e.MERCHANT_ACCOUNT_NUMBER}]);
  assert.deepEqual(payload.checkAmount,{type:'eq',amount:'100'});
  return new Response(JSON.stringify(result('200200')),{status:200,headers:{'Content-Type':'application/json'}});
 };
 try{
  const verified=await verifySlip(makeFile(),order(),e);
  assert.equal(calls,1);
  assert.equal(verified.amount,100);
  assert.equal(verified.reference,'BANK-ABC-00000001');
 }finally{globalThis.fetch=original;}
});
test('mocked provider rejection never credits a paid order',async()=>{
 const e=env();e.PAYMENTS_ENABLED='true';
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify(result('200402')),{status:200,headers:{'Content-Type':'application/json'}});
 try{await assert.rejects(verifySlip(makeFile(),order(),e),/สลิปไม่ผ่านเงื่อนไข/);}
 finally{globalThis.fetch=original;}
});
test('payments disabled means no HTTP call to Slip2Go even with an uploaded image',async()=>{
 const e=env();let used=false;const orig=globalThis.fetch;
 globalThis.fetch=async()=>{used=true;throw Error('SHOULD NOT CALL');};
 try{
  await assert.rejects(verifySlip(makeFile(),order(),e),/payment not configured/);
  assert.equal(used,false);
 }finally{globalThis.fetch=orig;}
});
