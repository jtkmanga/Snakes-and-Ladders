import test from 'node:test';
import assert from 'node:assert/strict';
import {ACCOUNT_INFO_URL,probeAuthMode,compareAuthModes} from './auth-diagnostic.mjs';

const secret='TEST-ONLY-NOT-A-REAL-KEY';
const env={SLIP2GO_V2_SECRET:secret};
const ok=(code='200001',httpStatus=200,data={shopName:'Test'})=>({
  ok:httpStatus>=200&&httpStatus<300,status:httpStatus,
  json:async()=>({code,data,message:'this message must not be returned'})
});

test('documented mode sends the secret directly to the pinned account-info host',async()=>{
  let observed=null;
  const result=await probeAuthMode(env,{fetchFn:async(url,options)=>{
    observed={url,options};return ok();
  }});
  assert.equal(observed.url,ACCOUNT_INFO_URL);
  assert.equal(observed.options.method,'GET');
  assert.equal(observed.options.redirect,'manual');
  assert.equal(observed.options.headers.Authorization,secret);
  assert.equal(result.authenticated,true);
  assert.equal(result.providerCode,'200001');
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('shopName'));
});

test('legacy mode sends Bearer only when explicitly selected',async()=>{
  const seen=[];
  const r=await probeAuthMode(env,{mode:'legacy-bearer',fetchFn:async(url,options)=>{
    seen.push(options.headers.Authorization);return ok('401002',401);
  }});
  assert.deepEqual(seen,['Bearer '+secret]);
  assert.equal(r.authenticated,false);
  assert.equal(r.providerCode,'401002');
});

test('comparison tests legacy only after 401001 from documented mode',async()=>{
  const seen=[];
  const result=await compareAuthModes(env,{fetchFn:async(_,options)=>{
    seen.push(options.headers.Authorization);
    return seen.length===1?ok('401001',401):ok('401002',401);
  }});
  assert.deepEqual(seen,[secret,'Bearer '+secret]);
  assert.equal(result.documented.providerCode,'401001');
  assert.equal(result.legacyBearer.providerCode,'401002');
  assert.equal(result.verdict,'neither_scheme_authenticated');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('success documented mode skips legacy probe',async()=>{
  let count=0;
  const result=await compareAuthModes(env,{fetchFn:async()=>{count++;return ok()}});
  assert.equal(count,1);
  assert.equal(result.verdict,'documented_key_valid');
  assert.equal(result.legacyBearer,null);
});

test('401002 alone does not trigger legacy fallback or authorize payment',async()=>{
  let count=0;
  const result=await compareAuthModes(env,{fetchFn:async()=>{count++;return ok('401002',401)}});
  assert.equal(count,1);
  assert.equal(result.documented.authenticated,false);
  assert.equal(result.verdict,'not_an_auth_scheme_comparison');
});

test('provider must return expected success shape, not only status 200',async()=>{
  const r=await probeAuthMode(env,{fetchFn:async()=>ok('200001',200,null)});
  assert.equal(r.authenticated,false);
});

test('reject malformed secrets and unknown diagnostic modes without provider calls',async()=>{
  for(const value of ['', ' Bearer fake', 'Bearer fake','secret\n','"secret"']) {
    let called=false;
    await assert.rejects(()=>probeAuthMode({SLIP2GO_V2_SECRET:value},{fetchFn:()=>{called=true;return ok();}}));
    assert.equal(called,false);
  }
  await assert.rejects(()=>probeAuthMode(env,{mode:'write-order'}),/invalid_diagnostic_mode/);
});

test('provider messages and arbitrary data are not reflected',async()=>{
  const r=await probeAuthMode(env,{fetchFn:async()=>({
    ok:false,status:401,json:async()=>({code:'unexpected-token',message:'possible secret disclosure',
       data:{accountNumber:'0000000000'}})
  })});
  assert.equal(r.providerCode,'unexpected');
  assert.ok(!JSON.stringify(r).includes('possible secret disclosure'));
  assert.ok(!JSON.stringify(r).includes('0000000000'));
});

test('no writes, no QR and no follow redirects',async()=>{
  let urls=[];
  const r=await compareAuthModes(env,{fetchFn:async(url,options)=>{
    urls.push({url,method:options.method,redirect:options.redirect});
    return ok('401001',401);
  }});
  assert.equal(r.documented.authenticated,false);
  assert.equal(urls.length,2);
  assert.ok(urls.every(item=>item.url===ACCOUNT_INFO_URL&&item.method==='GET'&&item.redirect==='manual'));
});
