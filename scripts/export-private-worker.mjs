#!/usr/bin/env node
/**
 * Read-only, local-only V99 Worker snapshot.
 * NEVER run this in a public CI job or commit the export.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {privateExportLocation, requiresPrivateReview, safeModulePath, sourceRiskFlags} from '../src/source-safety.mjs';

const WORKER='snakes-and-ladders-staging';
const VERSION_V99='69c8e428-cd8c-4106-be91-ccc00cdf3e1e';
if(process.env.CI) throw new Error('Private Worker export is forbidden inside CI');
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--output') {
  throw new Error('Usage: node scripts/export-private-worker.mjs --output ../snakes-private-snapshot');
}
const cwd=await fs.realpath(process.cwd());
const destination=privateExportLocation(cwd,args[1]);
const {CF_API_TOKEN, CF_ACCOUNT_ID}=process.env;
if(!CF_API_TOKEN||!CF_ACCOUNT_ID) {
  throw new Error('Set CF_API_TOKEN and CF_ACCOUNT_ID in the local session; never place them in a script or commit');
}
if(!/^[a-f0-9]{32}$/i.test(CF_ACCOUNT_ID)) throw new Error('Invalid Cloudflare account identifier');

const api=`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER}`;
async function get(endpoint) {
  const response=await fetch(endpoint,{headers:{Authorization:`Bearer ${CF_API_TOKEN}`},
    redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!response.ok) throw new Error(`Cloudflare read failed (HTTP ${response.status})`);
  return response;
}
const deployment=await (await get(api+'/deployments')).json();
assert.equal(deployment.success,true,'Cloudflare deployment metadata unavailable');
const active=deployment.result?.deployments?.[0]?.versions?.[0]?.version_id;
if(active!==VERSION_V99) {
  throw new Error('Deployed version is not V99. Refusing to silently snapshot a different Worker');
}
const response=await get(api);
if(!response.headers.get('content-type')?.includes('multipart/form-data')) {
  throw new Error('Unexpected Worker download format; no local files written');
}
const form=await response.formData();
const modules=[];
for(const [name,entry] of form.entries()) {
  if(name==='metadata')continue; // Never export binding configuration here.
  safeModulePath(name);
  if(!entry||typeof entry.text!=='function')throw new Error('Unexpected non-file module');
  const source=await entry.text();
  modules.push({name,source});
}
if(modules.length!==24||!modules.some(x=>x.name==='main.js')||
   !modules.some(x=>x.name==='static.js')||
   !modules.some(x=>x.name==='rules.js')) {
  throw new Error('Unexpected Worker module list. No local files written');
}

await fs.mkdir(path.dirname(destination),{recursive:true});
const realParent=await fs.realpath(path.dirname(destination));
privateExportLocation(cwd,path.join(realParent,path.basename(destination)));
try{
  await fs.lstat(destination);
  throw new Error('Destination already exists; refuse to overwrite an earlier snapshot');
}catch(e){if(e?.code!=='ENOENT')throw e;}
await fs.mkdir(destination,{mode:0o700});
await fs.writeFile(path.join(destination,'.gitignore'),
  '*\n!.gitignore\n',{mode:0o600});

const manifest=[];
for(const {name,source} of modules) {
  const file=path.join(destination,'source',name);
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  await fs.writeFile(file,source,{mode:0o600,flag:'wx'});
  manifest.push({
    module:name,
    sha256:createHash('sha256').update(source).digest('hex'),
    bytes:Buffer.byteLength(source),
    privateReviewRequired:requiresPrivateReview(source),
    risk:sourceRiskFlags(source)
  });
}
manifest.sort((a,b)=>a.module.localeCompare(b.module));
const report={worker:WORKER,version:VERSION_V99,privateLocalSnapshot:true,
  note:'SOURCE IS NOT SANITIZED. DO NOT GIT ADD OR PUSH until financial/private-data review is complete.',
  modules:manifest};
await fs.writeFile(path.join(destination,'MANIFEST.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
await fs.writeFile(path.join(destination,'DO-NOT-COMMIT.txt'),
  'This directory contains a RAW private Cloudflare V99 source snapshot.\n'+
  'It can contain historical financial references and names. No provider secret was intentionally exported.\n'+
  'Never push this raw snapshot to a public repository. Review and externalize the recovery details first.\n'+
  'All source is protected from accidental git add by the root .gitignore.\n',
  {mode:0o600});
const flagged=manifest.filter(x=>x.privateReviewRequired).map(x=>x.module);
console.log(JSON.stringify({
  snapshotCreated:true,worker:WORKER,version:VERSION_V99,moduleCount:manifest.length,
  privateReviewRequired:flagged,
  nextStep:'Sanitize the private recovery modules BEFORE committing any source.'
},null,2));
