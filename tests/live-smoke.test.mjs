import test from 'node:test';
import assert from 'node:assert/strict';
import {stagingBase, readJson, checkHealth, checkConfig, checkOnline, checkLeaderboard, checkMaintenance} from '../src/contracts.mjs';

const enabled = process.env.RUN_LIVE_SMOKE === '1';
const base = stagingBase(process.env.STAGING_BASE_URL);
const live = (name, callback) => test(name, {skip: !enabled && 'Set RUN_LIVE_SMOKE=1 to query Staging'}, callback);

live('Staging health endpoint responds with matching identity', async () => {
  const {status,body} = await readJson(base,'/api/health');
  assert.equal(status, 200); checkHealth(body);
});

live('Public config never contains raw merchant account', async () => {
  const {status,body} = await readJson(base,'/api/config');
  assert.equal(status, 200); checkConfig(body);
});

live('Public online counts are nonnegative and fresh', async () => {
  const {status,body} = await readJson(base,'/api/online/counts');
  assert.equal(status, 200); checkOnline(body);
});

live('Server maintenance flags are public booleans', async () => {
  const {status,body} = await readJson(base,'/api/server/status');
  assert.equal(status, 200); checkMaintenance(body);
});

for (const server of ['free','vip']) {
  live(`${server} leaderboard response respects score bounds`, async () => {
    const {status,body} = await readJson(base,`/api/leaderboard?server=${server}`);
    assert.equal(status,200); checkLeaderboard(body);
  });
}

live('Private player endpoint rejects anonymous clients', async () => {
  const {status} = await readJson(base,'/api/me');
  assert.equal(status,401);
});

live('Admin endpoints reject anonymous clients', async () => {
  const {status} = await readJson(base,'/api/admin/session');
  assert.equal(status,401);
});

live('Matchmaking does not accept anonymous clients', async () => {
  // Auth fails before matchmaking. No room is created or modified.
  const {status} = await readJson(base,'/api/match',{method:'POST'});
  assert.equal(status,401);
});
