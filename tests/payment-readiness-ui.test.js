import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const client=readFileSync(new URL('../public/game.js',import.meta.url),'utf8');
const worker=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
test('VIP purchase button starts disabled until the Worker reports payment readiness',()=>{
 assert.match(html,/<button[^>]*id="vip-buy"[^>]*disabled/);
 assert.match(client,/\$\('vip-buy'\)\.disabled=!permitted/);
 assert.match(client,/\$\('vip-buy'\)\.addEventListener\('click',\(\)=>buyProduct\('vip'\)\)/);
 assert.match(worker,/if\(!paymentConfigured\(env\)\)return json\(\{error:'ยังไม่เปิดรับชำระเงินจริง'\},503\)/);
});
test('payment reconciliation UI reuses the existing order without asking for another slip',()=>{
 assert.match(html,/id="payment-reconcile"[^>]*hidden/);
 assert.match(client,/async function reconcilePayment\(\)/);
 assert.match(client,/\/reconcile\`,\{method:'POST'\}/);
 assert.doesNotMatch(client.slice(client.indexOf('async function reconcilePayment'),client.indexOf('async function detectServer')),/form\.append\('slip'/);
});
