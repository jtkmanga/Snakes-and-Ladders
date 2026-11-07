import test from 'node:test';
import assert from 'node:assert/strict';
import qrcode from '../src/vendor/qrcode.mjs';
import {createPromptPayPayload,crc16CcittFalse,normalizePromptPayPhone} from '../src/promptpay.js';
import {readFileSync} from 'node:fs';

const main=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/game.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

function decodeTlv(s){
  const output={};let i=0;
  while(i<s.length){
    const tag=s.slice(i,i+2),len=Number(s.slice(i+2,i+4));
    if(!/^\d{2}$/.test(tag)||!Number.isInteger(len)||i+4+len>s.length)throw Error('Bad TLV');
    output[tag]=s.slice(i+4,i+4+len);i+=4+len;
  }
  return output;
}

test('PromptPay payload has dynamic exact amount, country, currency and valid CRC',()=>{
  const payload=createPromptPayPayload('0812345678',100);
  const f=decodeTlv(payload);
  assert.equal(f['00'],'01');
  assert.equal(f['01'],'12');
  assert.equal(f['58'],'TH');
  assert.equal(f['53'],'764');
  assert.equal(f['54'],'100.00');
  assert.equal(decodeTlv(f['29'])['00'],'A000000677010111');
  assert.equal(decodeTlv(f['29'])['01'],'0066812345678');
  assert.equal(f['63'].length,4);
  assert.equal(crc16CcittFalse(payload.slice(0,-4)),payload.slice(-4));
  assert.equal(createPromptPayPayload('0812345678',20).includes('540520.00'),true);
  assert.equal(createPromptPayPayload('0812345678',10).includes('540510.00'),true);
});
test('PromptPay phone and amount validation prevents malformed or arbitrary payees',()=>{
  assert.equal(normalizePromptPayPhone('0812345678'),'0812345678');
  for(const invalid of ['','081234567','08123456789','+66812345678','0000000000','0212345678','0812-345678','0812 345678']){
    assert.throws(()=>createPromptPayPayload(invalid,100),String(invalid));
  }
  for(const sum of [0,-1,0.01,100000.01,NaN,Infinity,'100',1e6]){
    assert.throws(()=>createPromptPayPayload('0812345678',sum),String(sum));
  }
});
test('MIT QR generator turns server payload into valid SVG with finder modules',()=>{
  const qr=qrcode(0,'M');qr.addData(createPromptPayPayload('0812345678',100));qr.make();
  assert(qr.getModuleCount()>=21);
  const svg=qr.createSvgTag({cellSize:5,margin:20,scalable:true});
  assert.match(svg,/<svg /);
  assert.match(svg,/<path /);
  assert.match(svg,/<\/svg>/);
});
test('the QR endpoint requires owner auth and a current server-created pending order',()=>{
  assert.match(main,/url\.pathname\.startsWith\('\/api\/orders\/'\)/);
  assert.match(main,/getAuthorizedUser\(request,env\)/);
  assert.match(main,/current=await ledger\(\)\.get\(id,user\.id\)/);
  assert.match(main,/if\(action==='qr'&&request\.method==='GET'\)/);
  assert.match(main,/current\.status!=='pending'\|\|Date\.now\(\)>current\.expires_at/);
  assert.match(main,/createPromptPayPayload\(env\.MERCHANT_ACCOUNT_NUMBER,current\.amount\)/);
  assert.match(main,/Cache-Control':'private, no-store'/);
  assert.match(main,/merchant:paymentConfigured\(env\)\?\{name:env\.MERCHANT_DISPLAY_NAME\|\|null,method:'promptpay_qr',account:null\}/);
});
test('no buyer phone printed as text in checkout UI or client Javascript',()=>{
  assert.match(html,/id="payment-qr"[^>]*hidden/);
  assert.match(html,/id="payment-qr-disabled"/);
  assert.match(ui,/await authorizedFetch\(\`\/api\/orders\/\$\{encodeURIComponent\(orderId\)\}\/qr\`/);
  assert.match(ui,/URL\.createObjectURL\(blob\)/);
  assert.doesNotMatch(ui,/MERCHANT_ACCOUNT_NUMBER|MERCHANT_PUBLIC_ACCOUNT/);
  assert.doesNotMatch(html,/MERCHANT_ACCOUNT_NUMBER|MERCHANT_PUBLIC_ACCOUNT/);
});

test('mobile image is saved as an opaque white-background PNG and payment stays gated',()=>{
  assert.match(html,/download="snakes-ladders-promptpay\.png"/);
  assert.match(ui,/canvas\.toBlob\(/);
  assert.match(ui,/ctx\.fillStyle='#ffffff'/);
  assert.match(ui,/ctx\.drawImage\(image,0,0,640,640\)/);
  assert.match(ui,/if\(!publicConfig\?\.paymentsEnabled\)/);
  assert.match(main,/if\(!paymentConfigured\(env\)\)return json\(\{error:'ยังไม่เปิดรับชำระเงินจริง'\},503\)/);
});
