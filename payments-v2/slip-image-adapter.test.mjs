import test from 'node:test';
import assert from 'node:assert/strict';
import {createPendingOrder} from './core.mjs';
import {validateSlipImage,prepareSlipVerification,verifySlipImageServer,SLIP_IMAGE_ENDPOINT} from './slip-image-adapter.mjs';
const now=Date.parse('2026-11-08T08:30:00Z');
const order=createPendingOrder({uid:'firebase-test-identity',sku:'shield',uuid:'11111111-2222-4333-8444-555555555555',now});
const recv={accountType:'02004',accountNumber:'123456789012345'};
const env={PAYMENTS_ENABLED:'false',PAYMENT_ROLLOUT:'disabled',SLIP2GO_V2_SECRET:'UNIT-TEST-SECRET-ONLY'};
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,1]);
const success={code:'200200',data:{amount:10,transRef:'TESTTX123456789',dateTime:new Date(now+10000).toISOString(),sender:{bank:{id:'004'}}}};
const fakeResponse=(data,status=200)=>({status,ok:status===200,json:async()=>data});

test('only PNG/JPEG byte signatures, max 4 MB',()=>{
 assert.equal(validateSlipImage(png).mime,'image/png');
 assert.equal(validateSlipImage(new Uint8Array([255,216,255,0,0,0,255,217])).mime,'image/jpeg');
 for(const bytes of [new Uint8Array([0,0,0,0,0,0,0,0]),new Uint8Array(4*1024*1024+1)])
  assert.throws(()=>validateSlipImage(bytes));
});
test('builds provider request using Bearer, PNG file, exact E-Wallet account and enforced checks',async()=>{
 const {url,options}=prepareSlipVerification({env,order,receiver:recv,bytes:png});
 assert.equal(url,SLIP_IMAGE_ENDPOINT);
 assert.equal(options.method,'POST');assert.equal(options.redirect,'manual');
 assert.equal(options.headers.Authorization,'Bearer UNIT-TEST-SECRET-ONLY');
 assert.equal(options.body.get('file').type,'image/png');
 const payload=JSON.parse(options.body.get('payload'));
 assert.deepEqual(payload,{checkDuplicate:true,checkReceiver:[{accountType:'02004',accountNumber:recv.accountNumber}],checkAmount:{type:'eq',amount:'10'}});
});
test('refuses wrong E-Wallet, unsafe mode, missing key, and nonpending orders',()=>{
 const input={env,order,receiver:recv,bytes:png};
 assert.throws(()=>prepareSlipVerification({...input,receiver:{accountType:'02001',accountNumber:'0812345678'}}),/invalid_receiver/);
 assert.throws(()=>prepareSlipVerification({...input,env:{...env,PAYMENTS_ENABLED:'true'}}),/safe_mode_required/);
 assert.throws(()=>prepareSlipVerification({...input,env:{...env,SLIP2GO_V2_SECRET:'Bearer BAD'}}),/invalid_provider_secret/);
 assert.throws(()=>prepareSlipVerification({...input,order:{...order,status:'fulfilled'}}),/not_pending_order/);
});
test('200200 yields a fingerprint but never grants an entitlement',async()=>{
 let calls=0;
 const result=await verifySlipImageServer({env,order,receiver:recv,bytes:png,now:now+11000,fetchFn:async(url,options)=>{
  calls++;assert.equal(url,SLIP_IMAGE_ENDPOINT);assert.equal(options.body.get('file').type,'image/png');return fakeResponse(success);
 }});
 assert.equal(calls,1);assert.match(result.fingerprint,/^[0-9a-f]{64}$/);
 assert.equal(result.amountBaht,10);assert.equal(result.verifiedBy,'provider_200200');assert.equal(result.entitlementGranted,false);
 assert.ok(!JSON.stringify(result).includes(recv.accountNumber));
 assert.ok(!JSON.stringify(result).includes(env.SLIP2GO_V2_SECRET));
});
test('200000, duplicate, receiver mismatch, amount mismatch, fake slip all fail closed',async()=>{
 for(const code of ['200000','200401','200402','200403','200404','200500','200501','200502','401001','500503']){
  await assert.rejects(()=>verifySlipImageServer({env,order,receiver:recv,bytes:png,now:now+11000,fetchFn:async()=>fakeResponse({...success,code})}),new RegExp('provider_declined_'+code));
 }
 await assert.rejects(()=>verifySlipImageServer({env,order,receiver:recv,bytes:png,now:now+11000,fetchFn:async()=>fakeResponse({...success,data:{...success.data,amount:11}})}),/amount_mismatch/);
});
test('provider HTTP failure, invalid JSON, unknown codes, timeout all fail closed',async()=>{
 const args={env,order,receiver:recv,bytes:png,now:now+11000};
 await assert.rejects(()=>verifySlipImageServer({...args,fetchFn:async()=>fakeResponse({},401)}),/provider_http_error/);
 await assert.rejects(()=>verifySlipImageServer({...args,fetchFn:async()=>({ok:true,status:200,json:async()=>{throw Error('bad')}})}),/provider_invalid_json/);
 await assert.rejects(()=>verifySlipImageServer({...args,fetchFn:async()=>fakeResponse({code:'unexpected'})}),/provider_unknown_code/);
 await assert.rejects(()=>verifySlipImageServer({...args,fetchFn:async()=>{throw Error('network')}}),/provider_network_error/);
});
