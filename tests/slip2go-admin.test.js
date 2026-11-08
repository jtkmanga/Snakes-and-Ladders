import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  adminAllowed,validSlipReference,slip2goAccountInfo,slip2goSlipHistory,Slip2GoAdminError
} from '../src/slip2go-admin.js';

const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const page=readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/admin.js',import.meta.url),'utf8');
const env={
  SLIP2GO_API_BASE_URL:'https://connect.slip2go.com/',
  SLIP2GO_SECRET:'mock-test-token-not-live',
  ADMIN_EMAIL:'admin@example.test',
  PAYMENTS_ENABLED:'false'
};
function reply(data,code='200001'){
  return {ok:true,json:async()=>({code,message:'Get Info Success',data})};
}
test('only email-verified Firebase user from server allowlist can access admin',()=>{
  assert.equal(adminAllowed({id:'uid-a',email:'ADMIN@EXAMPLE.TEST'},env),true);
  assert.equal(adminAllowed({id:'uid-a',email:'stranger@example.test'},env),false);
  assert.equal(adminAllowed({email:'admin@example.test'},env),false);
  assert.equal(adminAllowed({id:'uid-a',email:'admin@example.test'},{...env,ADMIN_EMAIL:''}),false);
  assert.match(worker,/url\.pathname\.startsWith\('\/api\/admin\/'\)/);
  assert.match(worker,/getAuthorizedUser\(request,env\)/);
  assert.match(worker,/if\(!adminAllowed\(user,env\)\)return json\(\{error:'ไม่มีสิทธิ์ใช้งาน Admin'\},403\)/);
  assert.match(worker,/if\(url\.pathname==='\/api\/admin\/session'\)return json\(\{admin:true\}\)/);
});
test('read-only account API calls correct pinned endpoint with secret header',async()=>{
  let calls=0;
  const fake=async(url,opts)=>{
    calls++;
    assert.equal(url,'https://connect.slip2go.com/api/account/info');
    assert.equal(opts.method,'GET');
    assert.equal(opts.headers.Authorization,env.SLIP2GO_SECRET);
    assert.equal(opts.redirect,'error');
    return reply({shopName:'Lucky Game',package:'BASIC-1',tokenRemaining:347,creditRemaining:0,
      quotaQrRemaining:90,estimatedQuotaSlip:347,packageExpiredDate:'2026-12-01T00:00:00Z'});
  };
  const result=await slip2goAccountInfo(env,fake);
  assert.equal(calls,1);
  assert.equal(result.shopName,'Lucky Game');
  assert.equal(result.tokenRemaining,347);
  assert.equal(result.quotaQrRemaining,90);
  assert.equal(JSON.stringify(result).includes(env.SLIP2GO_SECRET),false);
});
test('history API accepts only safe reference IDs and redacts bank information',async()=>{
  const ref='92887bd5-60d3-4744-9a98-b8574e123456';
  const fake=async(url,opts)=>{
    assert.equal(url,'https://connect.slip2go.com/api/verify-slip/'+ref);
    assert.equal(opts.headers.Authorization,env.SLIP2GO_SECRET);
    return reply({referenceId:ref,transRef:'BANK-123456',amount:100,
      dateTime:'2026-11-08T03:00:00Z',verifyDate:'2026-11-08T03:01:00Z',
      decode:'PRIVATE-QR',
      receiver:{account:{bank:{account:'1234567890'},name:'Recipient Private'},bank:{name:'Bank A'}},
      sender:{account:{bank:{account:'9876543210'},name:'Sender Private'},bank:{name:'Bank B'}}
    });
  };
  const result=await slip2goSlipHistory(env,ref,fake);
  assert.equal(result.amount,100);
  assert.equal(result.receiverAccount,'••••7890');
  assert.equal(result.receiverBank,'Bank A');
  const serialized=JSON.stringify(result);
  for(const secret of ['PRIVATE-QR','1234567890','9876543210','Recipient Private','Sender Private']){
    assert.equal(serialized.includes(secret),false,secret);
  }
});
test('lookup rejects path traversal, excessive references and malformed records',async()=>{
  for(const invalid of ['','a','../../../etc/passwd','hello?x=y','/api/account/info',
    'a'.repeat(129),'a%2Fb','日本語']){
    assert.equal(validSlipReference(invalid),false,invalid);
    await assert.rejects(slip2goSlipHistory(env,invalid,()=>{throw Error('Should not call provider')}),/Invalid/);
  }
  assert.equal(validSlipReference('AB12cd-1234_5678'),true);
  await assert.rejects(slip2goAccountInfo(env,async()=>reply({},'401001')),error=>
    error instanceof Slip2GoAdminError&&error.publicDiagnostic().providerCode==='401001');
  await assert.rejects(slip2goAccountInfo({...env,SLIP2GO_API_BASE_URL:'https://evil.example/'},async()=>{throw Error('Should not call provider')}),/invalid Slip2Go API origin/);
});
test('Admin UI is separate, read-only, secured, and never exposes API credentials',()=>{
  assert.match(page,/id="refresh-account"/);
  assert.match(page,/id="slip-reference"/);
  assert.match(page,/id="admin-content" hidden/);
  assert.match(ui,/\/api\/admin\/session/);
  assert.match(ui,/\/api\/admin\/slip2go\/account/);
  assert.match(ui,/\/api\/admin\/slip2go\/history\?referenceId=/);
  assert.doesNotMatch(page+ui,/SLIP2GO_SECRET|MERCHANT_ACCOUNT_NUMBER|PAYMENTS_ENABLED\\s*=\\s*true/);
});

test('Slip2Go authentication and IP whitelist errors yield sanitized diagnostics',async()=>{
  const secret='not-for-browser';
  for(const [status,code] of [[401,'401001'],[401,'401007'],[429,'429000'],[503,'500503']]){
    const fetchMock=async()=>({ok:false,status,json:async()=>({
      code,message:'Provider secret: '+secret,
      data:{accountNumber:'0123456789',rawQR:'VERY_SECRET'}
    })});
    await assert.rejects(slip2goAccountInfo(env,fetchMock),error=>{
      assert(error instanceof Slip2GoAdminError);
      const diagnostic=error.publicDiagnostic();
      assert.deepEqual(diagnostic,{reason:'provider_http',httpStatus:status,providerCode:code});
      const output=JSON.stringify(diagnostic);
      assert(!output.includes(secret)&&!output.includes('0123456789')&&!output.includes('VERY_SECRET'));
      return true;
    });
  }
});
test('non JSON, malformed replies, and network failures are classified without raw error leakage',async()=>{
  await assert.rejects(slip2goAccountInfo(env,async()=>({
    ok:false,status:403,json:async()=>{throw Error('HTML sensitive response text');}
  })),e=>e instanceof Slip2GoAdminError&&e.reason==='non_json'&&e.httpStatus===403);
  await assert.rejects(slip2goAccountInfo(env,async()=>({
    ok:true,status:200,json:async()=>({code:'200001',data:[]})
  })),e=>e instanceof Slip2GoAdminError&&e.reason==='invalid_response');
  await assert.rejects(slip2goAccountInfo(env,async()=>{throw Error('SECRET_NETWORK_BODY');}),
    e=>e instanceof Slip2GoAdminError&&e.reason==='network'&&!e.message.includes('SECRET_NETWORK_BODY'));
});
test('only authenticated Admin receives bounded error diagnostics',()=>{
  assert.match(worker,/if\(!adminAllowed\(user,env\)\)return json\(\{error:'ไม่มีสิทธิ์ใช้งาน Admin'\},403\)/);
  assert.match(worker,/e instanceof Slip2GoAdminError/);
  assert.match(worker,/const diagnostic=e\.publicDiagnostic\(\)/); 
  assert.match(ui,/function explainAdminFailure\(data,status\)/);
  assert.match(ui,/'401007':'IP Whitelist/);
  assert.doesNotMatch(ui,/SLIP2GO_SECRET/);
});
