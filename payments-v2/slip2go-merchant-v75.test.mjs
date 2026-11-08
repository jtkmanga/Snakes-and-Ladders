import test from 'node:test';
import assert from 'node:assert/strict';
import {slip2goAccountInfo,Slip2GoAdminError} from './slip2go-admin.js';
import {preflightBeforeMoney,validateMerchantReadiness} from './payment-canary.js';
const BASE={
 SLIP2GO_API_BASE_URL:'https://connect.slip2go.com/',
 SLIP2GO_V2_SECRET:'test_secret_not_real',
 MERCHANT_DISPLAY_NAME:'Lucky Game'
};
const payload={code:'200001',data:{
 shopName:'Lucky Game',
 package:'BASIC-1',
 packageExpiredDate:'2099-12-31T23:59:59.000Z',
 tokenRemaining:100,tokenPerSlip:0.25,checkSlipByCredit:false,creditRemaining:0,
 quotaQrRemaining:100
}};
function fake({status=200,body=payload}={}) {
 const requests=[];
 const fetcher=async(url,options)=>{
   requests.push({url,options});
   return {ok:status>=200&&status<300,status,json:async()=>body};
 };
 return {requests,fetcher};
}
test('merchant API uses V2 secret with Bearer rather than old missing V1 binding',async()=>{
 const {requests,fetcher}=fake();
 const account=await slip2goAccountInfo(BASE,fetcher);
 assert.equal(account.shopName,'Lucky Game');
 assert.equal(requests.length,1);
 assert.equal(requests[0].url,'https://connect.slip2go.com/api/account/info');
 assert.equal(requests[0].options.method,'GET');
 assert.equal(requests[0].options.headers.Authorization,'Bearer test_secret_not_real');
 assert.equal(requests[0].options.headers.Accept,'application/json');
 assert.equal(await preflightBeforeMoney(BASE,fetcher).then(r=>r.ok),true);
});
test('prefixed bearer keys normalize without duplicate Bearer prefix',async()=>{
 const {requests,fetcher}=fake();
 await slip2goAccountInfo({...BASE,SLIP2GO_V2_SECRET:'Bearer test_secret_not_real'},fetcher);
 assert.equal(requests[0].options.headers.Authorization,'Bearer test_secret_not_real');
});
test('missing V2 key rejects before external request; do not fall back to legacy secret',async()=>{
 const {requests,fetcher}=fake();
 const bad={...BASE,SLIP2GO_V2_SECRET:'',SLIP2GO_SECRET:'legacy_should_not_work'};
 await assert.rejects(()=>slip2goAccountInfo(bad,fetcher),e=>e instanceof Slip2GoAdminError&&e.reason==='configuration');
 assert.equal(requests.length,0);
});
test('provider auth rejection reports bounded code; never exposes secrets',async()=>{
 const {fetcher}=fake({status:401,body:{code:'401001',message:'Bad secret'}});
 await assert.rejects(()=>slip2goAccountInfo(BASE,fetcher),e=>{
   assert.equal(e instanceof Slip2GoAdminError,true);
   assert.equal(e.publicDiagnostic().providerCode,'401001');
   assert.equal(e.publicDiagnostic().httpStatus,401);
   assert.equal(JSON.stringify(e.publicDiagnostic()).includes(BASE.SLIP2GO_V2_SECRET),false);
   return true;
 });
});
test('missing shop and expired package never authorize payable QR',()=>{
 assert.equal(validateMerchantReadiness({...payload.data,shopName:'Different Shop'},BASE).ok,false);
 assert.equal(validateMerchantReadiness({...payload.data,shopName:'Lucky Game',packageExpiredDate:'2022-01-01'},BASE).ok,false);
 assert.equal(validateMerchantReadiness({...payload.data,shopName:'Lucky Game',tokenRemaining:0},BASE).ok,false);
});
