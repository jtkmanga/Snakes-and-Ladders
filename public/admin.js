import * as auth from './auth.js';
const $=id=>document.getElementById(id);
let authorized=false,busy=false;
const text=(id,value)=>{$(id).textContent=value==null||value===''?'—':String(value)};
const ready=()=>authorized&&Boolean(auth.currentUser());
async function api(path){
  if(!ready())throw Error('กรุณาเข้าสู่ระบบ Admin ก่อน');
  const token=await auth.idToken();
  const r=await fetch(path,{method:'GET',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
    headers:{Authorization:'Bearer '+token,Accept:'application/json'}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||('HTTP '+r.status));
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