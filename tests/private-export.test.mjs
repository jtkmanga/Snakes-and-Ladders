import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceRiskFlags,requiresPrivateReview,safeModulePath,privateExportLocation} from '../src/source-safety.mjs';

test('private source audit flags synthetic financial data, not its raw contents',()=>{
  assert.equal(requiresPrivateReview('export const TURN_MS = 20000;'),false);
  assert.equal(requiresPrivateReview('const order = "payv2-11111111-2222-3333-4444-555555555555";'),true);
  assert.equal(requiresPrivateReview('const sender = "testperson@gmail.com";'),true);
  assert.equal(requiresPrivateReview('const reference = "MTI0039369288631314817081";'),true);
  assert.equal(requiresPrivateReview('const account = "004999086038089";'),true);
  assert.equal(requiresPrivateReview('const password = "1234567890abcdefghijklmnopqrstuvwxyz";'),true);
  assert.equal(sourceRiskFlags('no secrets').embeddedCredential,false);
});

test('module filenames reject traversal and absolute paths',()=>{
  assert.equal(safeModulePath('payments-v2/core.mjs'),'payments-v2/core.mjs');
  for(const name of ['../secret','/etc/passwd','admin/../../x','x\\y','a//b','./file','']) {
    assert.throws(()=>safeModulePath(name));
  }
});

test('private export must be outside current public repository',()=>{
  const repo='/workspaces/Snakes-and-Ladders';
  assert.equal(privateExportLocation(repo,'../snakes-private-snapshot'),'/workspaces/snakes-private-snapshot');
  for(const dest of ['.', './backup','private/source','/workspaces/Snakes-and-Ladders/source']){
    assert.throws(()=>privateExportLocation(repo,dest));
  }
});
