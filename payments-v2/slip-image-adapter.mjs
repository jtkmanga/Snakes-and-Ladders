// Payment V2 server-side Slip2Go verification adapter. NOT wired into checkout.
// This code only creates a server-to-provider request and returns a verified,
// fingerprinted event. An independent, atomic durable ledger is still mandatory
// before a purchase may be fulfilled or any payment feature may be enabled.
import {makeProviderChecks,validateProviderSlip,transferFingerprint} from './core.mjs';
import {providerStageReady} from './provider-stage.mjs';

export const SLIP_IMAGE_ENDPOINT='https://connect.slip2go.com/api/verify-slip/qr-image/info';
const MAX_IMAGE_BYTES=4*1024*1024;
const ACCEPTED_ERRORS=new Set(['200000','200401','200402','200403','200404','200500','200501','200502','400001','400002','400003','400400','400409','401001','401002','401003','401004','401005','401006','401007','429000','500500','500503']);

export function validateSlipImage(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<8||bytes.byteLength>MAX_IMAGE_BYTES)
    throw Error('invalid_image');
  const png=[137,80,78,71,13,10,26,10].every((value,i)=>bytes[i]===value);
  const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217;
  if(png)return {mime:'image/png',name:'slip.png'};
  if(jpeg)return {mime:'image/jpeg',name:'slip.jpg'};
  throw Error('unsupported_image');
}

export function prepareSlipVerification({env,order,receiver,bytes,mode='synthetic'}){
  if(order?.version!==2||!['pending','verifying'].includes(order.status))throw Error('not_pending_order');
  if(!providerStageReady(env,mode))
    throw Error('provider_stage_not_authorized');
  // A staging-only adapter. This must not authorize checkout or grant items.
  // Never print, log, or return the request object to the browser.
  const secret=env?.SLIP2GO_V2_SECRET;
  if(typeof secret!=='string'||secret.length<8||secret!==secret.trim()||/^(Bearer|Basic)\s/i.test(secret)||/[\r\n\0-\x1f\x7f]/.test(secret))
    throw Error('invalid_provider_secret');
  const image=validateSlipImage(bytes);
  const payload=makeProviderChecks(order,receiver);
  if(payload.checkDuplicate!==true||payload.checkAmount?.type!=='eq'||payload.checkReceiver?.length!==1)
    throw Error('provider_checks_not_enforced');
  const form=new FormData();
  form.append('file',new Blob([bytes],{type:image.mime}),image.name);
  form.append('payload',JSON.stringify(payload));
  return {url:SLIP_IMAGE_ENDPOINT,options:{method:'POST',headers:{
    Authorization:'Bearer '+secret,Accept:'application/json'},
    redirect:'manual',body:form}};
}

export async function verifySlipImageServer({env,order,receiver,bytes,mode='synthetic',fetchFn=fetch,now=Date.now()}){
  const {url,options}=prepareSlipVerification({env,order,receiver,bytes,mode});
  let response;
  try{response=await fetchFn(url,{...options,signal:AbortSignal.timeout(12000)});}
  catch{throw Error('provider_network_error');}
  if(!response||response.status!==200||response.ok!==true)throw Error('provider_http_error');
  let answer;
  try{answer=await response.json();}catch{throw Error('provider_invalid_json');}
  // 200000 is only a slip lookup. Never treat it as a successful checkout.
  if(answer?.code!=='200200'){
    const code=String(answer?.code||'');
    throw Error(ACCEPTED_ERRORS.has(code)?'provider_declined_'+code:'provider_unknown_code');
  }
  const verification=validateProviderSlip(answer,order,{now});
  const fingerprint=await transferFingerprint(verification);
  // This is NOT a payment grant. Must later be committed atomically with the
  // order status by a unique transaction fingerprint before any entitlement.
  return Object.freeze({orderId:order.id,amountBaht:verification.amountBaht,
    transferredAt:verification.transferredAt,fingerprint,verifiedBy:'provider_200200',
    entitlementGranted:false});
}
