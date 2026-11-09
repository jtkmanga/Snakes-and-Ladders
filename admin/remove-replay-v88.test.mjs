import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const f=p=>fileURLToPath(new URL(p,import.meta.url));
const html=readFileSync(f('./game-index-v88.html'),'utf8');
const js=readFileSync(f('./staging-game-v88.mjs'),'utf8');
test('the demo replay button and dangling handler are gone',()=>{
 assert.ok(!html.includes('id="replay-btn"'));
 assert.ok(!html.includes('🔄 เริ่มเกมทดลองใหม่'));
 assert.ok(!js.includes("$('replay-btn')"));
 assert.ok(html.includes('id="events"'));
 assert.ok(html.includes('game.js?v=ui-clean-v88'));
});
test('the normal demo starter and other UI remain available and JS parses',()=>{
 const syntax=spawnSync(process.execPath,['--check',f('./staging-game-v88.mjs')],{encoding:'utf8'});
 assert.equal(syntax.status,0,syntax.stderr);
 assert.ok(html.includes('id="demo-btn"'));
 assert.ok(js.includes("$('demo-btn').addEventListener('click',()=>startDemo());"));
 assert.ok(js.includes('function startDemo(){'));
 assert.ok(html.includes('id="vip-buy"'));
 assert.ok(html.includes('id="board-map-name"'));
 assert.ok(html.includes('id="online-top-status"'));
 assert.ok(html.includes('id="token-layer"'));
 assert.ok(js.includes('nameplate.textContent=playerName'));
});
