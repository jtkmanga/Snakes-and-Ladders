import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=n=>fileURLToPath(new URL(n,import.meta.url));
const main=readFileSync(file('./staging-main-v81.mjs'),'utf8');
const ledger=readFileSync(file('./staging-ledger-v81.mjs'),'utf8');
const admin=readFileSync(file('./game-admin.js'),'utf8');
const html=readFileSync(file('./game-admin.html'),'utf8');
for(const name of ['staging-main-v81.mjs','staging-ledger-v81.mjs','game-admin.js','control-policy.mjs','admin-board.mjs']){
 test('JavaScript syntax '+name,()=>{
  const result=spawnSync(process.execPath,['--check',file('./'+name)],{encoding:'utf8'});
  assert.equal(result.status,0,name+': '+result.stderr);
 });
}
test('all moderation endpoints within verified Firebase + owner allowlist',()=>{
 const start=main.indexOf("if(url.pathname.startsWith('/api/admin/'))");
 const controls=main.indexOf("url.pathname.startsWith('/api/admin/control/')");
 const ban=main.indexOf("securityBan({uid:data.uid");
 assert.ok(start>=0 && controls>start && ban>controls);
 assert.ok(main.slice(start,controls).includes('adminAllowed(user,env)'));
 assert.ok(main.includes("if(data.uid===user.id)return json({error:'Cannot ban the administrator account'},403)"));
 assert.ok(main.includes("if(request.method!=='POST')return json({error:'Method not allowed'},405)"));
 assert.ok(main.includes("if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403)"));
 assert.ok(main.includes('getAuthorizedUser(request,env)'));
});
test('ban checks block matching, new WebSockets and active rolls without bypassing expiry',()=>{
 assert.ok(main.includes("const policy=await items().gameAccess({uid:user.id,server});"));
 assert.ok(main.includes("gameAccess({uid:player.id,server:game.server,ignoreMaintenance:true})"));
 assert.ok(main.includes("gameAccess({uid:pid,server:game.server,ignoreMaintenance:true})"));
 assert.ok(main.includes("if(Date.now()>=game.turnEndsAt){await this.timeout(game);return;}"));
 assert.ok(main.includes("gameAccess({uid:profile.id,server:profile.server})"));
});
test('maintenance is server-specific, does not kill in-progress matches',()=>{
 assert.ok(main.includes("url.pathname==='/api/server/status'"));
 assert.ok(main.includes("policy.code==='maintenance'?423:403"));
 assert.ok(main.includes("ignoreMaintenance:true"));
 assert.ok(ledger.includes('securityMaintenance(args)'));
 assert.ok(admin.includes("'/api/admin/control/maintenance'"));
});
test('VIP order audit is privacy-safe and only reads V2 VIP records',()=>{
 const i=ledger.indexOf('adminVipOrderHistory('),j=ledger.indexOf('  paidV2(){',i);
 const block=ledger.slice(i,j);
 assert.ok(block.includes("FROM v2_paid_orders WHERE sku='vip'"));
 assert.ok(block.includes('order:mask(row.id),buyer:mask(row.uid)'));
 assert.ok(!block.includes('tx_hash'));
 assert.ok(!block.includes('slip'));
 assert.ok(!block.includes('account_number'));
 assert.ok(main.includes("url.pathname==='/api/admin/payments/vip'"));
});
test('score export is paginated, admin-only, and CSV sheet formula injection is escaped',()=>{
 assert.ok(main.includes("if(action==='export')"));
 assert.ok(main.includes("adminExport({server,"));
 assert.ok(admin.includes("csvCell=value=>"));
 assert.ok(admin.includes("/^[=+\\-@\\t\\r\\n]/"));
 assert.ok(admin.includes('document.createElement'));
 assert.ok(html.includes('id="export-free-csv"'));
 assert.ok(html.includes('id="export-vip-json"'));
});
