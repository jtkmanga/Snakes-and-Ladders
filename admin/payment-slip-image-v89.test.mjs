import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const f=p=>fileURLToPath(new URL(p,import.meta.url));
const script=readFileSync(f('./staging-game-v89.mjs'),'utf8');
const html=readFileSync(f('./game-index-v89.html'),'utf8');
const from=script.indexOf('async function prepareSlipImageForUpload(file){');
const to=script.indexOf('async function submitSlip(){',from);
assert.ok(from>=0&&to>from);
const helper=script.slice(from,to);
const jpeg=()=>new Blob([new Uint8Array([255,216,255,224,1,2,3,255,217])],{type:'image/jpeg'});
const make=(overrides={})=>{
 const state={decoded:0,revoked:0,canvas:0};
 class MockImage{
   naturalWidth=1200;naturalHeight=1800;
   set src(url){state.decoded++;queueMicrotask(()=>this.onload?.());}
 }
 const web={createObjectURL:()=> 'blob:local',revokeObjectURL:()=>{state.revoked++}};
 const dom={createElement(type){
   assert.equal(type,'canvas');state.canvas++;
   return{width:0,height:0,
     getContext:()=>({fillRect(){},drawImage(){},set fillStyle(_){}}),
     toBlob:callback=>callback(jpeg())};
 }};
 const fn=new Function('URL','Image','document',helper+'return prepareSlipImageForUpload;')(web,MockImage,dom);
 return{fn,state,...overrides};
};
test('normal JPEG bypasses conversions and preserves original bytes',async()=>{
 const {fn,state}=make(),original=jpeg(),result=await fn(original);
 assert.equal(result.converted,false);
 assert.equal(result.blob,original);
 assert.equal(result.mime,'image/jpeg');
 assert.equal(state.decoded,0);
});
test('mislabeled or altered image can be normalized to strict JPEG without server bypass',async()=>{
 const {fn,state}=make();
 const altered=new Blob([new Uint8Array([255,216,255,224,1,2,3,5,6,7])],{type:'image/jpeg'});
 const result=await fn(altered);
 assert.equal(result.converted,true);
 assert.equal(result.mime,'image/jpeg');
 assert.deepEqual(Array.from(new Uint8Array(await result.blob.arrayBuffer())),Array.from(new Uint8Array(await jpeg().arrayBuffer())));
 assert.equal(state.decoded,1);
 assert.equal(state.revoked,1);
});
test('invalid bytes that browser cannot decode are rejected and not uploaded',async()=>{
 const fn=new Function('URL','Image','document',helper+'return prepareSlipImageForUpload;')(
  {createObjectURL:()=> 'blob:bad',revokeObjectURL:()=>{}},
  class BrokenImage{set src(_){queueMicrotask(()=>this.onerror?.());}},
  {createElement(){throw Error('no canvas');}}
 );
 await assert.rejects(()=>fn(new Blob(['not-an-image'],{type:'image/jpeg'})),/เปิดไฟล์สลิปไม่ได้/);
});
test('strict backend remains authoritative; user can retry same paid order',()=>{
 const check=spawnSync(process.execPath,['--check',f('./staging-game-v89.mjs')],{encoding:'utf8'});
 assert.equal(check.status,0,check.stderr);
 assert.ok(script.includes("const image=await prepareSlipImageForUpload(file)"));
 assert.ok(script.includes("headers:{'Content-Type':image.mime},body:image.blob"));
 assert.ok(script.includes("const response=await authorizedFetch('/api/me')"));
 assert.ok(script.includes("async function restoreLastPayment()"));
 assert.ok(script.includes("async function reconcilePayment()"));
 assert.ok(!script.includes("body:file})"));
 assert.ok(html.includes('game.js?v=slip-fix-v89'));
 assert.ok(html.includes('id="vip-buy"'));
 assert.ok(!html.includes('id="payment-restore"'));
 assert.ok(html.includes('id="payment-order"'));
});
