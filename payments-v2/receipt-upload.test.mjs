import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_SLIP_BYTES,readSlipImageRequest,publicSlipPreflightResult} from './receipt-upload.mjs';

const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
const jpeg=new Uint8Array([255,216,255,224,2,3,4,5,255,217]);
const req=(bytes,headers={'content-type':'image/png'})=>new Request('https://example.test/api/payments/v2/upload-preflight',
  {method:'POST',headers,body:bytes});

test('accepts PNG/JPEG as raw bytes without leaking source image',async()=>{
  const p=await readSlipImageRequest(req(png));
  assert.equal(p.mime,'image/png');assert.equal(p.size,png.length);
  const pub=publicSlipPreflightResult(p);
  assert.equal(pub.ok,true);assert.equal(pub.simulation,true);
  assert.equal(pub.providerCalled,false);
  assert.equal(pub.orderCreated,false);
  assert.equal(pub.entitlementGranted,false);
  assert.ok(!('bytes' in pub));
  const j=await readSlipImageRequest(req(jpeg,{'content-type':'image/jpeg'}));
  assert.equal(j.mime,'image/jpeg');
});
test('blocks spoofed MIME, unsupported formats, missing and short image',async()=>{
  await assert.rejects(()=>readSlipImageRequest(req(png,{'content-type':'image/jpeg'})),{code:'content_type_mismatch',status:415});
  await assert.rejects(()=>readSlipImageRequest(req(png,{'content-type':'application/octet-stream'})),{code:'unsupported_content_type',status:415});
  await assert.rejects(()=>readSlipImageRequest(req(new Uint8Array(15))),{code:'invalid_image_signature',status:415});
  await assert.rejects(()=>readSlipImageRequest(req(new Uint8Array(7))),{code:'image_required',status:400});
  const empty=new Request('https://example.test',{method:'POST',headers:{'content-type':'image/png'}});
  await assert.rejects(()=>readSlipImageRequest(empty),{code:'image_required',status:400});
});
test('fails closed for invalid request method and invalid declared content length',async()=>{
  await assert.rejects(()=>readSlipImageRequest(new Request('https://example.test')),{code:'method_not_allowed',status:405});
  for(const len of ['abc','-1',String(MAX_SLIP_BYTES+1),'0','999999999999999999999999']){
    await assert.rejects(()=>readSlipImageRequest(req(png,{'content-type':'image/png','content-length':len})),
      {code:'invalid_content_length'});
  }
  await assert.rejects(()=>readSlipImageRequest(req(png,{'content-type':'image/png','content-length':String(png.length+1)})),{code:'content_length_mismatch',status:400});
});
test('enforces stream limit when content-length omitted',async()=>{
  const stream=new ReadableStream({start(controller){
    controller.enqueue(new Uint8Array([137,80,78,71,13,10,26,10]));
    controller.enqueue(new Uint8Array(MAX_SLIP_BYTES));
    controller.close();
  }});
  const request=new Request('https://example.test',{method:'POST',headers:{'content-type':'image/png'},body:stream,duplex:'half'});
  await assert.rejects(()=>readSlipImageRequest(request),{code:'file_too_large',status:413});
});
test('accepts exactly maxBytes, rejects anything larger or invalid limit',async()=>{
  const full=new Uint8Array(MAX_SLIP_BYTES);
  full.set(png,0);
  const result=await readSlipImageRequest(req(full));
  assert.equal(result.size,MAX_SLIP_BYTES);
  await assert.rejects(()=>readSlipImageRequest(req(png),{maxBytes:MAX_SLIP_BYTES+1}),{code:'invalid_limit',status:500});
});
test('does not put image contents in a public preflight response',()=>{
  assert.deepEqual(Object.keys(publicSlipPreflightResult({mime:'image/png',size:16})).sort(),
    ['bytesRead','entitlementGranted','mediaType','ok','orderCreated','providerCalled','qrCreated','simulation','transferRecorded','validation'].sort());
});
