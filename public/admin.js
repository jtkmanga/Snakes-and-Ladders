import * as auth from './auth.js';
const $=id=>document.getElementById(id);
let authorized=false,busy=false;
const text=(id,value)=>{$(id).textContent=value==null||value===''?'—':String(value)};
const ready=()=>authorized&&Boolean(auth.currentUser());
// The server supplies only allowlisted diagnostic codes, not a provider response body.
function explainAdminFailure(data,status){
  const d=data?.diagnostic;
  if(!d||typeof d!=='object')return data?.error||('HTTP '+status);
  const details={
    '401001':'Secret Key ไม่ถูกต้องหรือไม่ตรงกับร้านนี้ ตรวจ Secret ใน Slip2Go และ Cloudflare',
    '401002':'ไม่พบร้าน Slip2Go สำหรับคีย์นี้',
    '401003':'บัญชี Slip2Go ถูกระงับ กรุณาติดต่อผู้ให้บริการ',
    '401004':'แพ็กเกจ Slip2Go หมดอายุ',
    '401005':'โทเคน Slip2Go ไม่เพียงพอ',
    '401006':'เครดิต Slip2Go ไม่เพียงพอ',
    '401007':'IP Whitelist ไม่อนุญาตให้ Cloudflare เรียก API ตรวจการตั้งค่าฝั่ง Slip2Go',
    '429000':'Slip2Go จำกัดจำนวนคำขอ โปรดลองอีกครั้งภายหลัง',
    '500500':'บริการ Slip2Go ขัดข้องชั่วคราว',
    '500503':'Slip2Go อยู่ระหว่างปรับปรุงระบบ',
    '400003':'ไม่พบ referenceId ของสลิปเดิม'
  };
  const reasons={
    configuration:'ค่าการเชื่อมต่อ API หรือ Secret บน Cloudflare ไม่ครบ',
    timeout:'Slip2Go ตอบกลับช้าเกินเวลาที่กำหนด',
    network:'เชื่อมต่อ Slip2Go ไม่สำเร็จ ตรวจเครือข่ายหรือการจำกัดคำขอ',
    non_json:'Slip2Go ส่งคำตอบที่ไม่ใช่ JSON ตรวจ URL, IP Whitelist หรือการบล็อกคำขอ',
    invalid_response:'ข้อมูลตอบกลับไม่ตรงรูปแบบคู่มือ API',
    internal:'มีข้อผิดพลาดภายใน Worker',
    provider_http:'Slip2Go ปฏิเสธคำขอ',
    provider_code:'Slip2Go ส่งรหัสข้อผิดพลาด'
  };
  const summary=details[d.providerCode]||reasons[d.reason]||'Slip2Go ส่งผลลัพธ์ผิดพลาด';
  const metadata=[d.providerCode?'รหัส '+d.providerCode:null,
    Number.isInteger(d.httpStatus)?'HTTP '+d.httpStatus:null].filter(Boolean).join(' / ');
  return '⚠️ '+summary+(metadata?' ('+metadata+')':'');
}
async function api(path){
  if(!ready())throw Error('กรุณาเข้าสู่ระบบ Admin ก่อน');
  const token=await auth.idToken();
  const r=await fetch(path,{method:'GET',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
    headers:{Authorization:'Bearer '+token,Accept:'application/json'}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(explainAdminFailure(data,r.status));
  return data;
}
async function checkAdmin(){
  const u=auth.currentUser();
  authorized=false;
  $('admin-content').hidden=true;
  if(!u){text('auth-message','กรุณาเข้าสู่ระบบด้วย Google บัญชีที่ได้รับสิทธิ์ Admin');text('session-badge','ยังไม่เข้าสู่ระบบ');$('sign-in').hidden=false;$('sign-out').hidden=true;return;}
  $('sign-in').hidden=true;$('sign-out').hidden=false;
  text('session-badge','กำลังตรวจสิทธิ์');
  try{
    // A live protected admin endpoint is the authority, never the email displayed in UI.
    const result=await apiAuthCheck();
    if(!result.admin)throw Error('บัญชีนี้ไม่ได้รับสิทธิ์ Admin');
    authorized=true;$('admin-content').hidden=false;
    text('session-badge','Admin ที่ได้รับอนุญาต');
    text('auth-message','เข้าสู่ระบบและยืนยันสิทธิ์ Admin สำเร็จ');
  }catch(e){text('session-badge','ไม่มีสิทธิ์');text('auth-message',e.message);}
}
async function apiAuthCheck(){
  const token=await auth.idToken();
  const r=await fetch('/api/admin/session',{method:'GET',cache:'no-store',referrerPolicy:'no-referrer',
    headers:{Authorization:'Bearer '+token,Accept:'application/json'}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||'ไม่สามารถตรวจสิทธิ์ Admin ได้');
  return data;
}
$('sign-in').addEventListener('click',async()=>{
  try{await auth.signIn();}catch(e){text('auth-message','Google Login ไม่สำเร็จ: '+(e.code||e.message));}
});
$('sign-out').addEventListener('click',async()=>{await auth.logOut();});
$('refresh-account').addEventListener('click',async()=>{
  if(!ready()||busy)return;
  busy=true;$('refresh-account').disabled=true;
  text('account-message','กำลังดึงข้อมูลจาก Slip2Go…');
  try{
    const {account}=await api('/api/admin/slip2go/account');
    text('shop-name',account.shopName);text('shop-package',account.package);
    text('package-expires',account.packageExpiredDate);
    text('token-remaining',account.tokenRemaining);
    text('credit-remaining',account.creditRemaining);
    text('qr-remaining',account.quotaQrRemaining);
    text('slip-estimated',account.estimatedQuotaSlip);
    text('token-per-slip',account.tokenPerSlip);
    text('account-message','โหลดข้อมูลบัญชีสำเร็จ (อ่านอย่างเดียว ไม่แก้ไขข้อมูล)');
  }catch(e){text('account-message','⚠️ '+e.message);}
  finally{busy=false;$('refresh-account').disabled=false;}
});
$('slip-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!ready())return;
  const ref=$('slip-reference').value.trim();
  if(!/^[A-Za-z0-9_-]{6,128}$/.test(ref)){text('slip-message','กรุณากรอก referenceId ให้ถูกต้อง');return;}
  $('lookup-slip').disabled=true;$('slip-details').hidden=true;
  text('slip-message','กำลังค้นหาสลิปเดิม…');
  try{
    const {slip}=await api('/api/admin/slip2go/history?referenceId='+encodeURIComponent(ref));
    text('result-reference',slip.referenceId);
    text('result-transaction',slip.transRef);
    text('result-amount',slip.amount==null?null:slip.amount+' บาท');
    text('result-date',slip.dateTime);
    text('result-verified',slip.verifyDate);
    text('result-bank',slip.receiverBank);
    text('result-receiver',slip.receiverAccount);
    text('result-sender-bank',slip.senderBank);
    $('slip-details').hidden=false;text('slip-message','พบข้อมูลสลิปแล้ว (ไม่เปิดสิทธิ์ VIP)');
  }catch(e){text('slip-message','⚠️ '+e.message);}
  finally{$('lookup-slip').disabled=false;}
});
async function start(){
  try{
    const r=await fetch('/api/config',{cache:'no-store'});
    if(!r.ok)throw Error('โหลดการตั้งค่าเกมไม่สำเร็จ');
    const config=await r.json();
    if(!config.firebase)throw Error('Firebase ไม่พร้อม');
    await auth.initialize(config.firebase,()=>{void checkAdmin();});
  }catch(e){text('auth-message','⚠️ '+e.message);}
}
void start();