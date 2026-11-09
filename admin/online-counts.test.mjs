import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const f=p=>fileURLToPath(new URL(p,import.meta.url));
const main=readFileSync(f('./staging-main-v82.mjs'),'utf8');
const game=readFileSync(f('./staging-game-v82.mjs'),'utf8');
const html=readFileSync(f('./game-index-v82.html'),'utf8');
const admin=readFileSync(f('./game-admin.js'),'utf8');
const adminHtml=readFileSync(f('./game-admin.html'),'utf8');
test('new game and worker code parse as JavaScript',()=>{
 for(const name of ['staging-main-v82.mjs','staging-game-v82.mjs','game-admin.js']){
  const r=spawnSync(process.execPath,['--check',f('./'+name)],{encoding:'utf8'});
  assert.equal(r.status,0,name+': '+r.stderr);
 }
});
test('online public API contains counts only, from same Free/VIP Scores DOs as Admin',()=>{
 const start=main.indexOf("if(url.pathname==='/api/online/counts'&&request.method==='GET')");
 const end=main.indexOf("if(url.pathname==='/api/server/status'",start);
 assert.ok(start>=0&&end>start);
 const route=main.slice(start,end);
 assert.ok(route.includes("'scores-'+server+'-v1'"));
 assert.ok(route.includes('.onlineCount(server)'));
 assert.ok(route.includes('free:free.online,vip:vip.online'));
 assert.ok(route.includes("'Cache-Control':'no-store'"));
 assert.ok(!route.includes('email:')&&!route.includes('uid:')&&!route.includes('name:'));
 assert.ok(main.includes('async onlineCount(server)'));
});
test('live count UI appears on server selection, lobby, match, and topbar',()=>{
 for(const id of ['online-top-status','auth-online-free','auth-online-vip','lobby-online-status','game-online-status'])
  assert.ok(html.includes('id="'+id+'"'),'Missing '+id);
 assert.ok(game.includes("fetch('/api/online/counts',{cache:'no-store'"));
 assert.ok(game.includes('setInterval(()=>{if(document.visibilityState===\'visible\')reloadOnlineCounts();},15000)'));
 assert.ok(game.includes('document.addEventListener(\'visibilitychange\''));
 assert.ok(game.includes('sendPresence().then(reloadOnlineCounts)'));
});
test('admin displays same backend counts and explicitly labels 90-second activity window',()=>{
 assert.ok(admin.includes("fetch('/api/online/counts',{cache:'no-store'}"));
 assert.ok(admin.includes("$(key+'-online-tag').textContent=Number(counts[key])"));
 assert.ok(admin.includes('90 วินาทีล่าสุด'));
 assert.ok(adminHtml.includes('id="online-overview-updated"'));
});
test('failed count request never silently reports zero',()=>{
 assert.ok(game.includes('onlineCountSnapshot=null'));
 assert.ok(game.includes(":'—'"));
 assert.ok(admin.includes("'— ออนไลน์'"));
});
