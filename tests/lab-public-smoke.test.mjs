import test from 'node:test';
import assert from 'node:assert/strict';

// Public read-only contract only. This file must not import private game
// modules, access repo secrets, create matches, or open WebSockets.
const enabled = process.env.RUN_LIVE_SMOKE === '1';
const host = 'snakes-and-ladders-game-loadlab.jtkmanga.workers.dev';
const allow = new Set([
  'ok','isolated','enabled','maxClients','gameClasses',
  'gameDataConnected','paymentEnabled','realUserAuth'
]);

test('isolated Load Lab public health exposes no credentials or user data',
  {skip: !enabled && 'Only scheduled/manual smoke reads public health'}, async () => {
    const res = await fetch('https://' + host + '/lab/health', {
      method: 'GET',
      redirect: 'error',
      headers: {'Accept':'application/json'},
      signal: AbortSignal.timeout(12000)
    });
    assert.equal(res.status,200,'Isolated Load Lab public health must respond');
    assert.match(res.headers.get('content-type')||'',/application\/json/);
    const body = await res.json();
    assert.equal(body.ok,true);
    assert.equal(body.isolated,true);
    assert.equal(body.maxClients,100);
    assert.equal(typeof body.enabled,'boolean'); // May be in authorized test window.
    assert.equal(body.paymentEnabled,false);
    assert.equal(body.gameDataConnected,false);
    assert.equal(body.realUserAuth,false);
    assert.equal(typeof body.gameClasses,'string');
    for (const key of Object.keys(body)) {
      assert.ok(allow.has(key),'Unexpected public health field');
    }
  }
);
