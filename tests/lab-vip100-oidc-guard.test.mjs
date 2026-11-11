import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const runner=readFileSync(new URL('../scripts/lab-vip100-oidc.mjs',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/lab-oidc-manual.yml',import.meta.url),'utf8');

test('public synthetic runner is hard-bound to one isolated host and 100 users',()=>{
 assert.match(runner,/HOST='snakes-and-ladders-game-loadlab\.jtkmanga\.workers\.dev'/);
 assert.match(runner,/MAX_CLIENTS=100,MAX_ROOMS=50,MAX_RUN_MS=190000/);
 assert.match(runner,/IDLE_ALARM_MS=80000/);
 assert.match(runner,/MAX_BATCH=10/);
 assert.match(runner,/process\.argv\.length,2/);
 assert.match(runner,/RUN_ISOLATED_VIP100_ALARM/);
 assert.match(runner,/GITHUB_EVENT_NAME,'workflow_dispatch'/);
 assert.match(runner,/GITHUB_REF,'refs\/heads\/main'/);
 assert.match(runner,/clients\.length<MAX_CLIENTS/);
 assert.match(runner,/server:'vip'/);
});
test('public probe never embeds or prints private credentials or queries payment',()=>{
 for(const s of ['SLIP2GO_','FIREBASE_','CF_API_TOKEN','GAME_LAB_TOKEN','PRIVATE_REPOSITORY','secrets.','/api/pay','/admin']){
  assert.equal(runner.includes(s),false,'Prohibited private reference '+s);
 }
 assert.doesNotMatch(runner,/console\.(log|error)\(.*liveToken/);
 assert.match(runner,/headers:\{Authorization:'Bearer '\+liveToken/);
 assert.match(runner,/method:post===undefined\?'GET':'POST'/);
 assert.match(runner,/health\.enabled,true/);
 assert.match(runner,/paymentEnabled,false/);
 assert.match(runner,/gameDataConnected,false/);
 assert.match(runner,/realUserAuth,false/);
});
test('public OIDC workflow requires manual input and never pushes a load run',()=>{
 assert.match(workflow,/workflow_dispatch:/);
 assert.doesNotMatch(workflow,/^  push:/m);
 assert.match(workflow,/run_vip100:/);
 assert.match(workflow,/default: false/);
 assert.match(workflow,/id-token: write/);
 assert.match(workflow,/permissions:/);
 assert.match(workflow,/RUN_ISOLATED_VIP100_ALARM/);
 assert.match(workflow,/timeout-minutes: 5/);
 assert.doesNotMatch(workflow,/CF_API_TOKEN|GAME_LAB_TOKEN|SLIP2GO_|FIREBASE_|secrets\./i);
});
