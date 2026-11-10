#!/usr/bin/env node
/** Read V99+ worker source through a private CF token, in memory only. Never log module content. */
import assert from 'node:assert/strict';
import {STAGING_HOST} from '../src/contracts.mjs';

const {CF_API_TOKEN,CF_ACCOUNT_ID} = process.env;
if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
  console.log('SKIP deployed-source audit: CF_API_TOKEN and CF_ACCOUNT_ID not configured');
  process.exit(0);
}
const worker = 'snakes-and-ladders-staging';
const url=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CF_ACCOUNT_ID)}/workers/scripts/${worker}`;
const response=await fetch(url,{headers:{Authorization:`Bearer ${CF_API_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(15000)});
if (!response.ok) throw Error(`Cloudflare source download failed (HTTP ${response.status})`);
const form=await response.formData();
async function source(name) {
  const file=form.get(name);
  assert.ok(file && typeof file.text==='function',`Cloudflare bundle missing ${name}`);
  return file.text();
}
const [main,rules,score,security,ledger] = await Promise.all([
  source('main.js'), source('rules.js'), source('admin/admin-board.mjs'),
  source('security.js'), source('payments-v2/atomic-ledger.mjs')
]);
const checks={
  'Staging host guard':main.includes(STAGING_HOST),
  'Turn duration 20 seconds':rules.includes('TURN_MS = 20_000'),
  'Three no-roll turns close room':main.includes('maxNoRollTurns(){return 3;}'),
  '5 boards configured':(rules.match(/id:\d+,name:/g)||[]).length===5,
  'VIP limit 100':rules.includes('VIP_LIMIT = 100'),
  'Two-player VIP and three-player Free':rules.includes("server==='vip'?2:3"),
  'Server generates dice':main.includes('randomInt(6)+1'),
  'Turn refreshed after async permissions check':main.includes('const turn=this.load();'),
  'No client-controlled score credit':score.includes('SELECT award_id FROM admin_awards WHERE award_id=?'),
  '500 and 1000 point prize support':score.includes('points<=0||points>1000'),
  'Signed Firebase token':security.includes('crypto.subtle.verify'),
  'Atomic payment de-duplication':ledger.includes('v2_unique_transfers'),
  'Provider-only payment confirmation':ledger.includes('providerVerified('),
};
for (const [name,pass] of Object.entries(checks)) {
  console.log(`${pass?'PASS':'FAIL'} ${name}`);
  assert.ok(pass,`Deployed-source audit failed: ${name}`);
}
console.log(`PASS ${Object.keys(checks).length} read-only deployed-code checks; no source persisted`);
