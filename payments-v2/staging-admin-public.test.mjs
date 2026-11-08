import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const path=fileURLToPath(new URL('./staging-admin-v72.html',import.meta.url));
const h=readFileSync(path,'utf8');

test('real Payment V2 Admin has no fake/mock transaction buttons',()=>{
 for(const id of ['simulate-401002','checkout-dry-run','save-test-v2','list-test-v2',
  'mock-run','mock-history','atomic-run','atomic-history','e2e-mock-run',
  'e2e-mock-history','upload-preflight-run','test-order-sku','probe','auth-compare',
  'receiver-check','receiver-confirm'])assert.ok(!h.includes('id="'+id+'"'),id);
 assert.ok(h.includes('id="login"'));
 assert.ok(h.includes('id="refresh"'));
});
test('Admin is login-protected and reads only live payment state without modifying orders',()=>{
 assert.ok(h.includes('/api/admin/session'));
 assert.ok(h.includes('/api/payments/v2/live/status'));
 assert.ok(h.includes('/api/payments/v2/live/orders'));
 assert.ok(h.includes('/api/payment/preflight'));
 assert.ok(h.includes('auth.idToken()'));
 assert.ok(h.includes('id="admin" hidden'));
 assert.ok(!h.includes('/api/payments/v2/demo-orders'));
 assert.ok(!h.includes("method:'POST'"));
});
test('embedded JavaScript parses cleanly as module',()=>{
 const match=h.match(/<script type="module">([\s\S]*?)<\/script>/);
 assert.ok(match?.[1]);
 const result=spawnSync(process.execPath,['--check','--input-type=module'],{input:match[1],encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
