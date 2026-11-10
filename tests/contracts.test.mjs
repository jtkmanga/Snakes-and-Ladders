import test from 'node:test';
import assert from 'node:assert/strict';
import {stagingBase, checkHealth, checkConfig, checkOnline, checkLeaderboard, checkMaintenance} from '../src/contracts.mjs';

test('staging URL guard rejects production and deceptive hosts', () => {
  assert.equal(stagingBase(), 'https://snakes-and-ladders-staging.jtkmanga.workers.dev');
  for (const bad of [
    'http://snakes-and-ladders-staging.jtkmanga.workers.dev',
    'https://snakes-and-ladders.jtkmanga.workers.dev',
    'https://snakes-and-ladders-staging.jtkmanga.workers.dev.attacker.invalid',
    'https://snakes-and-ladders-staging.jtkmanga.workers.dev/?token=x',
    'https://user:pass@snakes-and-ladders-staging.jtkmanga.workers.dev',
    'https://snakes-and-ladders-staging.jtkmanga.workers.dev/ws'
  ]) assert.throws(() => stagingBase(bad));
});

test('health and config validate only documented public fields', () => {
  checkHealth({ok:true, mode:'staging', game:'snakes-and-ladders', authConfigured:true, paymentsEnabled:false});
  assert.throws(() => checkHealth({ok:true,mode:'production',game:'snakes-and-ladders',authConfigured:true,paymentsEnabled:false}));
  checkConfig({paymentsEnabled:false,paymentV2Stage5Locked:false,merchant:null,firebase:null});
  assert.throws(() => checkConfig({paymentsEnabled:true,paymentV2Stage5Locked:false,merchant:{account:'secret'}}));
});

test('leaderboard validates score boundaries and prevents invalid totals', () => {
  checkLeaderboard({leaders:[{name:'Player',score:10}]});
  assert.throws(() => checkLeaderboard({leaders:[{name:'Player',score:-10}]}));
  assert.throws(() => checkLeaderboard({leaders:[{name:'Player',score:1.5}]}));
});

test('online count and maintenance status schema', () => {
  checkOnline({free:0,vip:2,asOf:Date.now(),windowSeconds:90});
  checkMaintenance({maintenance:{free:false,vip:false}});
  assert.throws(() => checkOnline({free:-1,vip:0,asOf:Date.now(),windowSeconds:90}));
  assert.throws(() => checkMaintenance({maintenance:{free:'false',vip:false}}));
});
