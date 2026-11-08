// Staging-only slip-image ingest boundary.
// The Worker receives raw image bytes over an authenticated same-origin POST,
// validates size + content type + signature, then (in a future approved step)
// server code may convert the bytes to Slip2Go multipart data.
// Never persist bytes, log their contents, or echo them to clients.
import {validateSlipImage} from './slip-image-adapter.mjs';

export const MAX_SLIP_BYTES=4*1024*1024;
export const ACCEPTED_SLIP_MEDIA=new Set(['image/png','image/jpeg']);

export class SlipUploadError extends Error {
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}

export async function readSlipImageRequest(request,{maxBytes=MAX_SLIP_BYTES}={}){
  if(!request || request.method!=='POST')throw new SlipUploadError('method_not_allowed',405);
  if(!Number.isSafeInteger(maxBytes)||maxBytes<8||maxBytes>MAX_SLIP_BYTES)
    throw new SlipUploadError('invalid_limit',500);
  const media=(request.headers?.get('content-type')||'').toLowerCase().trim();
  if(!ACCEPTED_SLIP_MEDIA.has(media))throw new SlipUploadError('unsupported_content_type',415);
  const givenLength=request.headers?.get('content-length');
  if(givenLength!==null && ( !/^\d+$/.test(givenLength) ||
    !Number.isSafeInteger(Number(givenLength)) ||
    Number(givenLength)>maxBytes || Number(givenLength)<8 ))
    throw new SlipUploadError('invalid_content_length',413);
  if(!request.body || typeof request.body.getReader!=='function')
    throw new SlipUploadError('image_required',400);

  // Streaming read avoids buffering an unbounded body when Content-Length is absent.
  const reader=request.body.getReader();
  const chunks=[];
  let total=0;
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      if(!(value instanceof Uint8Array))throw new SlipUploadError('bad_body',400);
      total+=value.byteLength;
      if(total>maxBytes)throw new SlipUploadError('file_too_large',413);
      chunks.push(value);
    }
  }catch(err){
    if(err instanceof SlipUploadError)throw err;
    throw new SlipUploadError('upload_read_failed',400);
  }finally{
    try{await reader.cancel();}catch{}
    try{reader.releaseLock();}catch{}
  }
  if(total<8)throw new SlipUploadError('image_required',400);
  if(givenLength!==null && Number(givenLength)!==total)
    throw new SlipUploadError('content_length_mismatch',400);

  const bytes=new Uint8Array(total);
  let pos=0;
  for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}
  let detected;
  try{detected=validateSlipImage(bytes);}
  catch{throw new SlipUploadError('invalid_image_signature',415);}
  if(detected.mime!==media)throw new SlipUploadError('content_type_mismatch',415);
  // Return only volatile bytes to the private server handler, never as JSON.
  return {bytes,mime:detected.mime,size:bytes.byteLength};
}

export function publicSlipPreflightResult(input){
  if(!input||!ACCEPTED_SLIP_MEDIA.has(input.mime)||
    !Number.isSafeInteger(input.size)||input.size<8||input.size>MAX_SLIP_BYTES)
    throw new SlipUploadError('invalid_preflight',500);
  return Object.freeze({
    ok:true,simulation:true,validation:'image_upload_accepted',
    mediaType:input.mime,bytesRead:input.size,
    providerCalled:false,orderCreated:false,qrCreated:false,
    transferRecorded:false,entitlementGranted:false,
  });
}
