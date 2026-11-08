// Slip2Go administrator read-only helpers.
// Never return the provider API token, raw slip QR/decode, or full bank account identifiers.
import { providerEndpoint } from './payments.js';

const ADMIN_ORIGIN='https://connect.slip2go.com';
function adminEndpoint(env, pathname){
  // Verify the configured origin with the same strict pin as payment verification.
  providerEndpoint(env);
  if(!env.SLIP2GO_SECRET)throw Error('Slip2Go credential not configured');
  return ADMIN_ORIGIN+pathname;
}
export function adminAllowed(user, env){
  return Boolean(user?.id&&user?.email&&typeof env.ADMIN_EMAIL==='string'
    &&env.ADMIN_EMAIL.trim().length>0
    &&user.email.trim().toLowerCase()===env.ADMIN_EMAIL.trim().toLowerCase());
}
export function validSlipReference(referenceId){
  return typeof referenceId==='string'
    &&referenceId.length>=6&&referenceId.length<=128
    &&/^[A-Za-z0-9_-]+$/.test(referenceId);
}
function text(value,max=120){
  return typeof value==='string'?value.slice(0,max):null;
}
function number(value){
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
}
function boolean(value){return typeof value==='boolean'?value:null;}
function maskedAccount(value){
  if(typeof value!=='string')return null;
  const digits=value.replace(/\D/g,'');
  return digits.length>=4?'••••'+digits.slice(-4):null;
}
async function readProvider(env,path,providerFetch){
  const url=adminEndpoint(env,path);
  let response;
  try{
    response=await providerFetch(url,{
      method:'GET',headers:{Authorization:env.SLIP2GO_SECRET,Accept:'application/json'},
      redirect:'error',signal:AbortSignal.timeout(12000)
    });
  }catch{throw Error('Slip2Go connection failed');}
  if(!response?.ok)throw Error('Slip2Go could not provide data');
  const body=await response.json().catch(()=>null);
  if(String(body?.code)!=='200001'||!body?.data||typeof body.data!=='object'){
    throw Error('Slip2Go returned no valid admin data');
  }
  return body.data;
}
export async function slip2goAccountInfo(env,providerFetch=fetch){
  const d=await readProvider(env,'/api/account/info',providerFetch);
  return {
    shopName:text(d.shopName),package:text(d.package),
    packageExpiredDate:text(d.packageExpiredDate,40),
    tokenLimit:number(d.tokenLimit),tokenRemaining:number(d.tokenRemaining),
    creditRemaining:number(d.creditRemaining),
    autoRenewalPackage:boolean(d.autoRenewalPackage),
    checkSlipByCredit:boolean(d.checkSlipByCredit),
    quotaQrLimit:number(d.quotaQrLimit),quotaQrRemaining:number(d.quotaQrRemaining),
    tokenPerSlip:number(d.tokenPerSlip),estimatedQuotaSlip:number(d.estimatedQuotaSlip)
  };
}
export async function slip2goSlipHistory(env,referenceId,providerFetch=fetch){
  if(!validSlipReference(referenceId))throw Error('Invalid Slip2Go referenceId');
  const d=await readProvider(env,'/api/verify-slip/'+encodeURIComponent(referenceId),providerFetch);
  return {
    referenceId:text(d.referenceId,128),
    transRef:text(d.transRef,128),
    amount:number(d.amount),dateTime:text(d.dateTime,40),
    verifyDate:text(d.verifyDate,40),
    receiverBank:text(d.receiver?.bank?.name,100),
    receiverAccount:maskedAccount(d.receiver?.account?.bank?.account||d.receiver?.account?.proxy?.account),
    senderBank:text(d.sender?.bank?.name,100)
  };
}
