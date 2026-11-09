import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const path=fileURLToPath(new URL('./staging-main-v72.mjs',import.meta.url));
const code=readFileSync(path,'utf8');

test('current V72 Worker main parses',()=>{
 const r=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
});
test('authenticated owner is the only real-money buyer during first 10-baht canary',()=>{
 assert.ok(code.includes("if(!adminAllowed(buyer,env))return json({error:'Owner canary only'},403)"));
 assert.ok(code.includes('liveCheckoutOpen(env,buyer)'));
 assert.ok(code.includes('canPurchase:liveCheckoutOpen(env,user).ok'));
 assert.ok(code.includes("env.PAYMENT_ROLLOUT==='canary'&&parsed.sku!=='shield'"));
});
test('provider merchant must pass real read-only preflight before a new order or payable QR',()=>{
 const live=code.slice(code.indexOf('V2_STAGE5_ORDER_ROUTES'),code.indexOf('V2_GAME_BUYER_PREVIEW'));
 const matches=live.match(/preflightBeforeMoney\(env\)/g)||[];
 assert.equal(matches.length,2);
 assert.ok(live.includes('Merchant not ready'));
 assert.ok(live.includes('liveCheckoutOpen(env,buyer)'));
 assert.ok(live.includes('new Response(svg'));
});
test('no public rollout accidentally enabled by real canary flag',()=>{
 assert.ok(code.includes("paymentsEnabled:paymentPublicEnabled(env)&&!V2_STAGE5_LOCKED"));
 assert.ok(code.includes('paymentV2Stage5Locked:V2_STAGE5_LOCKED'));
 assert.ok(code.includes("PAYMENT_REBUILD_V2_DISABLED"));
});
