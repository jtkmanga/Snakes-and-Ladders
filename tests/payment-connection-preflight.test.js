import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {slip2goAccountInfo,Slip2GoAdminError} from '../src/slip2go-admin.js';
import {paymentConfigured} from '../src/payments.js';
const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/game.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const secret='synthetic-test-only';
const env={
  SLIP2GO_SECRET:secret,SLIP2GO_API_BASE_URL:'https://connect.slip2go.com/',
  PAYMENTS_ENABLED:'false',ADMIN_EMAIL:'owner@example.invalid'
};

test('read-only provider preflight authenticates with raw Secret Key (documented by Slip2Go)',async()=>{
  assert.equal(paymentConfigured(env),false,'preflight must not enable payment');
  let calls=0;
  const data=await slip2goAccountInfo(env,async(url,init)=>{
    calls++;
    assert.equal(url,'https://connect.slip2go.com/api/account/info');
    assert.equal(init.method,'GET');
    assert.equal(init.headers.Authorization,secret);
    assert.equal(init.redirect,'error');
    assert.equal(init.body,undefined,'preflight never creates orders or charges');
    return Response.json({code:'200001',data:{shopName:'Lucky Game',package:'BASIC-1',tokenRemaining:347,quotaQrRemaining:12}});
  });
  assert.equal(calls,1);
  assert.equal(data.shopName,'Lucky Game');
  assert.equal(data.tokenRemaining,347);
  assert.equal(JSON.stringify(data).includes(secret),false);
});

test('preflight returns sanitized error class and never exposes provider payload or Secret',async()=>{
  await assert.rejects(slip2goAccountInfo(env,async()=>new Response(JSON.stringify({
    code:'401007',message:'Invalid IP with private key '+secret,
    data:{recipientAccount:'0812345678'}
  }),{status:401,headers:{'content-type':'application/json'}})),error=>{
    assert(error instanceof Slip2GoAdminError);
    assert.deepEqual(error.publicDiagnostic(),{reason:'provider_http',httpStatus:401,providerCode:'401007'});
    assert(!JSON.stringify(error.publicDiagnostic()).includes(secret));
    assert(!JSON.stringify(error.publicDiagnostic()).includes('0812345678'));
    return true;
  });
});

test('API checks verified owner and same-origin, and does not depend on checkout flag',()=>{
  assert.match(worker,/url\.pathname==='\/api\/payment\/preflight'\|\|url\.pathname==='\/api\/orders'/);
  assert.match(worker,/if\(!requireSameOrigin\(request\)\)/);
  assert.match(worker,/user=await getAuthorizedUser\(request,env\)/);
  assert.match(worker,/if\(!adminAllowed\(user,env\)\)return json\(\{error:'ไม่มีสิทธิ์ตรวจสอบการเชื่อมต่อ Slip2Go'\},403\)/);
  const section=worker.slice(worker.indexOf("if(url.pathname==='/api/payment/preflight')"),worker.indexOf("if(url.pathname.startsWith('/api/admin/'))"));
  assert.match(section,/if\(request\.method!=='GET'\)/);
  assert.match(section,/slip2goAccountInfo\(env\)/);
  assert.doesNotMatch(section,/createPromptPayPayload|verifySlip\(|ledger\(\)\.create|paymentConfigured\(env\)\)return/);
  assert.match(worker,/canPaymentPreflight:adminAllowed\(user,env\)/);
});

test('mobile preflight button stays hidden except for owner, and no-order recovery finishes loading',()=>{
  assert.match(html,/id="payment-preflight" type="button" hidden/);
  assert.match(ui,/\$\('payment-preflight'\)\.hidden=!Boolean\(serverMe\?\.canPaymentPreflight\)/);
  assert.match(ui,/authorizedFetch\('\/api\/payment\/preflight',\{method:'GET'\}\)/);
  assert.match(ui,/\$\('payment-preflight'\)\.addEventListener\('click',testPaymentConnection\)/);
  assert.match(ui,/ไม่มี QR เพราะยังไม่มีคำสั่งซื้อจริง/);
  const section=ui.slice(ui.indexOf('async function testPaymentConnection(){'),ui.indexOf('async function restoreLastPayment(){'));
  assert.doesNotMatch(section,/method:'POST'|\/verify|\/api\/orders/);
});