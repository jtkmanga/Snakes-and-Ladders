// Slip2Go REST API adapter. Always verify a real transfer to configured merchant.
export const PRODUCTS=Object.freeze({
  vip:{amount:100,description:'VIP 30 วัน',kind:'vip'},
  win2:{amount:20,description:'คะแนนชนะ ×2 / 24 ชั่วโมง',kind:'item'},
  shield:{amount:10,description:'เกราะกันงู / 24 ชั่วโมง',kind:'item'}
});
export const ORDER_LIFETIME_MS=15*60*1000;
// Supply exact API origin from your Slip2Go dashboard; refuse unverified default hosts.
function providerEndpoint(env){
  const base=new URL(env.SLIP2GO_API_BASE_URL);
  if(base.protocol!=='https:'||!(base.hostname==='slip2go.com'||base.hostname.endsWith('.slip2go.com'))||base.username||base.password||base.port||base.search||base.hash||base.pathname!=='/')throw Error('invalid Slip2Go API origin');
  return new URL('/api/verify-slip/qr-image/info',base).toString();
}
export function paymentConfigured(env){return Boolean(env.SLIP2GO_SECRET&&env.SLIP2GO_API_BASE_URL&&env.MERCHANT_ACCOUNT_TYPE&&env.MERCHANT_ACCOUNT_NUMBER&&env.MERCHANT_DISPLAY_NAME&&env.MERCHANT_PUBLIC_ACCOUNT&&env.PAYMENTS_ENABLED==='true');}
export function validateSlipResponse(answer,price){
  // The provider's 200200 indicates the requested receiver/amount/duplicate checks succeeded.
  if(String(answer?.code)!=='200200')throw new Error('สลิปไม่ผ่านเงื่อนไขการตรวจสอบ');
  const data=answer.data;
  if(!data||Number(data.amount)!==price)throw new Error('จำนวนเงินไม่ถูกต้อง');
  if(typeof data.transRef!=='string'||data.transRef.length<6||data.transRef.length>200)throw new Error('ไม่มีรหัสธุรกรรมธนาคาร');
  if(typeof data.decode!=='string'||data.decode.length<10||data.decode.length>1500)throw new Error('ไม่มีรหัสอ้างอิง QR ที่ตรวจสอบได้');
  const at=Date.parse(data.dateTime);
  if(!Number.isFinite(at)||at>Date.now()+180000||at<Date.now()-20*60*1000)throw new Error('สลิปเกินเวลาที่กำหนด');
  return {reference:data.transRef,qr:data.decode,amount:data.amount,at};
}
export async function verifySlip(file,order,env){
  if(!paymentConfigured(env))throw Error('payment not configured');
  if(!file||typeof file.arrayBuffer!=='function'||file.size>4_000_000||file.size<100||!['image/png','image/jpeg'].includes(file.type))throw Error('รองรับเฉพาะรูป PNG/JPG ขนาดไม่เกิน 4MB');
  if(Date.now()>order.expiresAt)throw Error('คำสั่งซื้อหมดอายุ');
  const checks={
    checkDuplicate:true,
    checkReceiver:[{accountType:env.MERCHANT_ACCOUNT_TYPE,accountNumber:env.MERCHANT_ACCOUNT_NUMBER,...(env.MERCHANT_ACCOUNT_NAME_TH?{accountNameTH:env.MERCHANT_ACCOUNT_NAME_TH}:{})}],
    checkAmount:{type:'eq',amount:String(order.amount)}
  };
  const form=new FormData();form.append('file',file,file.name?.slice(0,80)||'slip.jpg');form.append('payload',JSON.stringify(checks));
  const response=await fetch(providerEndpoint(env),{method:'POST',headers:{Authorization:env.SLIP2GO_SECRET},body:form,signal:AbortSignal.timeout(15000)});
  const answer=await response.json().catch(()=>({}));
  if(!response.ok)throw Error('Slip2Go ตรวจสอบไม่ได้');
  const validated=validateSlipResponse(answer,order.amount);
  if(validated.at<order.createdAt-120000)throw Error('โอนก่อนสร้างคำสั่งซื้อมากเกินไป');
  return validated;
}
export async function transferFingerprint(data){
  const payload=new TextEncoder().encode(data.reference+'|'+data.qr);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',payload)),x=>x.toString(16).padStart(2,'0')).join('');
}
