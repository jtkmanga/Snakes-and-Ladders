import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {validateSlipResponse,transferFingerprint} from '../src/payments.js';

const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const ledger=readFileSync(new URL('../src/ledger.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const ui=readFileSync(new URL('../public/game.js',import.meta.url),'utf8');

test('payment recovery API is authenticated and scopes orders to the current Google user',()=>{
  assert.match(worker,/url\.pathname==='\/api\/orders\/recent'&&request\.method==='GET'/);
  assert.match(worker,/ledger\(\)\.getRecent\(user\.id\)/);
  assert.match(worker,/url\.pathname==='\/api\/orders'/);
  assert.match(worker,/getAuthorizedUser\(request,env\)/);
  assert.match(ledger,/WHERE uid=\? AND created_at>=\?/);
  assert.match(ledger,/ORDER BY CASE WHEN status='verified' THEN 0/);
  assert.match(ledger,/LIMIT 1/);
});
test('recover recent order is owner-scoped and read-only even if another user paid',()=>{
  const code=ledger.slice(ledger.indexOf('export class PaymentLedger'),ledger.indexOf('export class Inventory'))
    .replace('export class PaymentLedger','class PaymentLedger')+'\nPaymentLedger;';
  class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}
  const PaymentLedger=runInNewContext(code,{DurableObject,Date,ORDER_LIFETIME_MS:900_000,PRODUCTS:{},structuredClone});
  const records=[
    {id:'order-b',uid:'other',status:'verified',created_at:Date.now()},
    {id:'order-a',uid:'current',status:'verified',created_at:Date.now()-5000}
  ];
  const ctx={storage:{sql:{exec:(query,...args)=>({
    toArray:()=>query.startsWith('SELECT')?records.filter(o=>o.uid===args[0]&&o.created_at>=args[1]).slice(0,1):[]
  })},kv:{}}};
  const store=new PaymentLedger(ctx,{});
  assert.equal(store.getRecent('current').id,'order-a');
  assert.equal(store.getRecent('nobody'),null);
});
test('player can recover pending or verified payment without creating another transfer',()=>{
  assert.match(html,/id="payment-restore"/);
  assert.match(ui,/async function restoreLastPayment\(\)/);
  assert.match(ui,/authorizedFetch\('\/api\/orders\/recent'\)/);
  assert.match(ui,/order\.status==='verified'/);
  assert.match(ui,/order\.status==='fulfilled'/);
  const section=ui.slice(ui.indexOf('async function restoreLastPayment(){'),ui.indexOf('function showPaymentPreview(){'));
  assert.doesNotMatch(section,/method:'POST'/);
  assert.doesNotMatch(section,/\/verify/);
  assert.match(section,/อย่าโอนซ้ำ/);
  assert.match(ui,/\$\('payment-restore'\)\.addEventListener\('click',restoreLastPayment\)/);
});
test('Slip2Go proof must pass merchant checks and creates stable anti-replay fingerprint',async()=>{
  const now=new Date().toISOString();
  const input={code:'200200',data:{amount:100,transRef:'BANK123456789',sender:{bank:{id:'004'}},dateTime:now}};
  const receipt=validateSlipResponse(input,100);
  assert.equal(receipt.reference,'004:BANK123456789');
  const same=validateSlipResponse({...input,data:{...input.data,decode:'different-image'}},100);
  assert.equal(await transferFingerprint(receipt),await transferFingerprint(same));
  for(const code of ['200000','200401','200402','200500','200501']){
    assert.throws(()=>validateSlipResponse({...input,code},100));
  }
});
