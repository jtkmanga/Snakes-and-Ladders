/** Read-only checks for the deployed Staging API, not a copy of game logic. */
import assert from 'node:assert/strict';

export const STAGING_HOST = 'snakes-and-ladders-staging.jtkmanga.workers.dev';

export function stagingBase(value = `https://${STAGING_HOST}`) {
  const u = new URL(value);
  assert.equal(u.protocol, 'https:', 'Only HTTPS is allowed');
  assert.equal(u.hostname, STAGING_HOST, 'Only the exact staging host is allowed');
  assert.equal(u.port, '', 'Custom ports are forbidden');
  assert.equal(u.username, '', 'Credentials are forbidden');
  assert.equal(u.password, '', 'Credentials are forbidden');
  assert.equal(u.pathname, '/', 'Base URL must not contain a path');
  assert.equal(u.search, '', 'Base URL must not contain a query');
  assert.equal(u.hash, '', 'Base URL must not contain a fragment');
  return u.origin;
}

export function checkHealth(j) {
  assert.equal(j?.ok, true);
  assert.equal(j?.mode, 'staging');
  assert.equal(j?.game, 'snakes-and-ladders');
  assert.equal(typeof j?.authConfigured, 'boolean');
  assert.equal(typeof j?.paymentsEnabled, 'boolean');
}

export function checkConfig(j) {
  assert.equal(typeof j?.paymentsEnabled, 'boolean');
  assert.equal(typeof j?.paymentV2Stage5Locked, 'boolean');
  if (j?.merchant != null) {
    assert.equal(j.merchant.account, null, 'Public config must not reveal account number');
  }
  // Firebase public client config is intentionally public, not a server secret.
  if (j?.firebase != null) {
    assert.equal(typeof j.firebase.projectId, 'string');
    assert.equal(typeof j.firebase.authDomain, 'string');
  }
}

export function checkOnline(j) {
  for (const key of ['free', 'vip']) {
    assert.equal(Number.isSafeInteger(j?.[key]), true, key + ' online count must be an integer');
    assert.ok(j[key] >= 0);
  }
  assert.equal(j.windowSeconds, 90);
  assert.equal(Number.isSafeInteger(j.asOf), true);
  assert.ok(Math.abs(j.asOf - Date.now()) < 5 * 60 * 1000, 'Online counter must be fresh');
}

export function checkLeaderboard(j) {
  assert.ok(Array.isArray(j?.leaders));
  assert.ok(j.leaders.length <= 50);
  for (const row of j.leaders) {
    assert.equal(typeof row.name, 'string');
    assert.equal(Number.isSafeInteger(row.score), true);
    assert.ok(row.score >= 0 && row.score <= 999999999);
  }
}

export function checkMaintenance(j) {
  assert.equal(typeof j?.maintenance?.free, 'boolean');
  assert.equal(typeof j?.maintenance?.vip, 'boolean');
}

export async function readJson(base, path, {method = 'GET', timeout = 10000} = {}) {
  const u = new URL(path, stagingBase(base));
  assert.equal(u.origin, stagingBase(base), 'Do not leave staging');
  const response = await fetch(u, {
    method,
    headers: { 'Accept': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`Expected JSON at ${u.pathname}; HTTP ${response.status}`);
  }
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`Bad JSON at ${u.pathname}; HTTP ${response.status}`); }
  return { status: response.status, body };
}
