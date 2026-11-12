import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const runner=readFileSync(new URL('../scripts/lab-vip100-gameplay-oidc.mjs',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/lab-oidc-manual.yml',import.meta.url),'utf8');
test('hard-coded isolated host, 100 active sockets and 101 maximum including one reconnect',()=>{
 assert.match(runner,/HOST='snakes-and-ladders-game-loadlab\.jtkmanga\.workers\.dev'/);
 assert.match(runner,/CLIENT_LIMIT=100, ROOM_LIMIT=50, CONNECTION_LIMIT=101/);
 assert.match(runner,/HARD_LIMIT_MS=230000, PLAY_MS=65000, IDLE_MS=68000/);
 assert.match(runner,/ROLL_SPACING_MS=9000, PAIR_BATCH=2/);
 assert.match(runner,/STAGES=\[10,30,100\]/);
 assert.match(runner,/all\.length<CONNECTION_LIMIT/);
 assert.match(runner,/process\.argv\.length,2/);
 assert.match(runner,/RUN_ISOLATED_VIP100_GAMEPLAY/);
 assert.match(runner,/GITHUB_EVENT_NAME,'workflow_dispatch'/);
 assert.match(runner,/GITHUB_REF,'refs\/heads\/main'/);
 assert.match(runner,/server:'vip'/);
});
test('must use short-lived OIDC, never a private secret or payment/admin API',()=>{
 assert.match(runner,/ACTIONS_ID_TOKEN_REQUEST_URL/);
 assert.match(runner,/ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
 assert.match(runner,/headers:\{Authorization:'Bearer '\+bearer/);
 assert.match(runner,/health\.enabled,true/);
 assert.match(runner,/health\.gameDataConnected,false/);
 assert.match(runner,/health\.paymentEnabled,false/);
 assert.match(runner,/health\.realUserAuth,false/);
 assert.doesNotMatch(runner,/secrets\.|SLIP2GO_|FIREBASE_|CF_API_TOKEN|GAME_LAB_TOKEN|\/api\/pay|\/admin|PRIVATE_REPOSITORY|console\.log\(bearer\)/i);
 assert.match(runner,/assert\.ok\(\['\/lab\/session','\/lab\/match','\/lab\/status'\]\.includes\(path\)\)/);
});
test('live gameplay, server dice, reconnect and no-roll must all be checked',()=>{
 assert.match(runner,/async function serverDiceAntiCheat/);
 assert.match(runner,/async function reconnect/);
 assert.match(runner,/async function activeGame/);
 assert.match(runner,/async function idleRoomAndKeepOthersActive/);
 assert.match(runner,/lastRoll>=1&&next\.lastRoll<=6/);
 assert.match(runner,/before\.turnEndsAt/);
 assert.match(runner,/prior\.expected=4001/);
 assert.match(runner,/peers\.expected=4003/);
 assert.match(runner,/assert\.ok\(rolls>=200/);
 assert.match(runner,/assert\.equal\(openCount\(\),98\)/);
 assert.match(runner,/OIDC_VIP100_GAMEPLAY_RESULT/);
});
test('no push-triggered gameplay, two mutually exclusive manual booleans default off',()=>{
 assert.match(workflow,/workflow_dispatch:/);
 assert.doesNotMatch(workflow,/^  push:/m);
 for(const key of ['run_vip100:','run_vip100_gameplay:'])assert.match(workflow,new RegExp(key));
 assert.ok((workflow.match(/default: false/g)||[]).length>=2);
 assert.match(workflow,/inputs\.run_vip100_gameplay && !inputs\.run_vip100/);
 assert.match(workflow,/inputs\.run_vip100 && !inputs\.run_vip100_gameplay/);
 assert.match(workflow,/!inputs\.run_vip100 && !inputs\.run_vip100_gameplay/);
 assert.match(workflow,/id-token: write/);
 assert.match(workflow,/timeout-minutes: 5/);
 assert.doesNotMatch(workflow,/secrets\.|GAME_LAB_TOKEN|CF_API_TOKEN|SLIP2GO_|FIREBASE_/i);
});
