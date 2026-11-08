// Slip2Go REST API adapter. Always verify a real transfer to configured merchant.
export const PRODUCTS=Object.freeze({
  vip:{amount:100,description:'VIP 30 วัน',kind:'vip'},
  win2:{amount:20,description:'คะแนนชนะ ×2 / 24 ชั่วโมง',kind:'item'},
  shield:{amount:10,description:'เกราะกันงู / 24 ชั่วโมง',kind:'item'}
});
export const ORDER_LIFETIME_MS=15*60*1000;
// Preserve a 24-hour verification recovery window for money transferred before QR expiry.
export const RECEIPT_RECOVERY_MS=24*60*60*1000;
// Supply exact API origin from your Slip2Go dashboard; refuse unverified default hosts.
export function providerEndpoint(env){
  const base=new URL(env.SLIP2GO_API_BASE_URL);
  if(base.protocol!=='https:'||base.hostname!=='connect.slip2go.com'||base.username||base.password||base.port||base.search||base.hash||base.pathname!=='/')throw Error('invalid Slip2Go API origin');
  return new URL('/api/verify-slip/qr-image/info',base).toString();
}
export function paymentReadiness(env){
  const apiOriginProvided=typeof env.SLIP2GO_API_BASE_URL==='string'&&env.SLIP2GO_API_BASE_URL.length>0;
  let validApiOrigin=false;
  if(apiOriginProvided)try{providerEndpoint(env);validApiOrigin=true;}catch{}
  const receiverConfigured=env.MERCHANT_ACCOUNT_TYPE==='02004'&&/^\d{15}$/.test(env.MERCHANT_ACCOUNT_NUMBER||'');
  const secretConfigured=Boolean(env.SLIP2GO_SECRET);
  const merchantConfigured=Boolean(env.MERCHANT_DISPLAY_NAME);
  const enabled=env.PAYMENTS_ENABLED==='true';
  // Only non-secret readiness flags are ever returned to a browser.
  return {enabled,apiOriginConfigured:validApiOrigin,receiverConfigured,secretConfigured,merchantConfigured,
    ready:enabled&&validApiOrigin&&receiverConfigured&&secretConfigured&&merchantConfigured};
}
// PromptPay QR checkout only. Do not require or publish a full account number.
export function paymentConfigured(env){
  return paymentReadiness(env).ready;
}
export function paymentRolloutAllowed(env,user){
  // Default safe mode is owner-only canary, even if payments become configured.
  // Public rollout always requires an explicit PAYMENT_ROLLOUT='public' value.
  if(!user?.id||!user?.email)return false;
  if(env.PAYMENT_ROLLOUT==='public')return true;
  if(env.PAYMENT_ROLLOUT&&env.PAYMENT_ROLLOUT!=='canary')return false;
  const owner=String(env.ADMIN_EMAIL||'').trim().toLowerCase();
  return Boolean(owner&&user.email.trim().toLowerCase()===owner);
}
export function paymentPublicEnabled(env){
  return paymentConfigured(env)&&env.PAYMENT_ROLLOUT==='public';
}

export function validateSlipResponse(answer,price){
  // 200200 proves all requested merchant and amount checks passed.
  // Do NOT grant on 200000 ("Slip found") without these checks.
  if(String(answer?.code)!=='200200')throw new Error('สลิปไม่ผ่านเงื่อนไขการตรวจสอบ');
  const data=answer?.data;
  if(!data||Number(data.amount)!==price)throw new Error('จำนวนเงินไม่ถูกต้อง');
  const transRef=typeof data.transRef==='string'?data.transRef.trim():'';
  const referenceId=typeof data.referenceId==='string'?data.referenceId.trim():'';
  if((transRef.length<6||transRef.length>200)&&(referenceId.length<6||referenceId.length>128))
    throw new Error('ไม่มีรหัสธุรกรรมธนาคาร');
  const senderBank=typeof data.sender?.bank?.id==='string'?data.sender.bank.id.trim():'';
  const reference=transRef.length>=6&&transRef.length<=200
    ?(senderBank&&/^[A-Za-z0-9]{1,16}$/.test(senderBank)?senderBank+':':'')+transRef
    :'ref:'+referenceId;
  const at=Date.parse(data.dateTime);
  if(!Number.isFinite(at)||at>Date.now()+180000)throw new Error('วันเวลาสลิปไม่ถูกต้อง');
  // The payment ledger owns global duplicate protection; no raw slip QR is persisted.
  return {reference,amount:Number(data.amount),at};
}
export async function verifySlip(file,order,env){
  if(!paymentConfigured(env))throw Error('payment not configured');
  if(!file||typeof file.arrayBuffer!=='function'||file.size>4_000_000||file.size<100||!['image/png','image/jpeg'].includes(file.type))throw Error('รองรับเฉพาะรูป PNG/JPG ขนาดไม่เกิน 4MB');
  if(Date.now()>order.createdAt+RECEIPT_RECOVERY_MS)throw Error('หมดเวลาส่งสลิป กรุณาติดต่อผู้ดูแล พร้อมเลขคำสั่งซื้อ');
  const checks={
    // The same Slip2Go shop may serve more than one game. Provider duplicate
    // checks protect against replay across projects; the DO ledger independently
    // rejects replay within this game.
    checkDuplicate:true,
    checkReceiver:[{accountType:env.MERCHANT_ACCOUNT_TYPE,accountNumber:env.MERCHANT_ACCOUNT_NUMBER,...(env.MERCHANT_ACCOUNT_NAME_TH?{accountNameTH:env.MERCHANT_ACCOUNT_NAME_TH}:{})}],
    checkAmount:{type:'eq',amount:String(order.amount)}
  };
  const form=new FormData();form.append('file',file,file.name?.slice(0,80)||'slip.jpg');form.append('payload',JSON.stringify(checks));
  const response=await fetch(providerEndpoint(env),{method:'POST',// Slip2Go's documented API authorization is the raw secret as header value.
    headers:{Authorization:env.SLIP2GO_SECRET},body:form,redirect:'manual',signal:AbortSignal.timeout(15000)});
  const answer=await response.json().catch(()=>({}));
  if(!response.ok)throw Error('Slip2Go ตรวจสอบไม่ได้');
  const validated=validateSlipResponse(answer,order.amount);
  if(validated.at<order.createdAt-120000)throw Error('โอนก่อนสร้างคำสั่งซื้อมากเกินไป');
  if(validated.at>order.expiresAt+60000)throw Error('สลิปโอนหลังคำสั่งซื้อหมดอายุ กรุณาติดต่อผู้ดูแล');
  return validated;
}
export async function transferFingerprint(data){
  if(typeof data?.reference!=='string'||data.reference.length<6||data.reference.length>220)throw Error('invalid transfer reference');
  const payload=new TextEncoder().encode('slip2go-transaction-v1|'+data.reference);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',payload)),x=>x.toString(16).padStart(2,'0')).join('');
}
