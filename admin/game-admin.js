import * as auth from './auth.js';
const $=id=>document.getElementById(id);
const fmtTime=value=>value?new Date(Number(value)).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'medium',timeStyle:'short'}):'—';
const esc=(v)=>v==null||v===''?'—':String(v);
let permitted=false,server='free',historyServer='free',offset=0,onlineOnly=false,editing=null,refreshing=false;
let tick=null,toastTimer=null;
let bansOffset=0,vipTxnOffset=0,exporting=false;
const status=(txt,ok=false)=>{$('connection').textContent=txt;$('connection').classList.toggle('ok',ok);};
const toast=(txt,error=false)=>{$('toast').textContent=txt;$('toast').classList.toggle('error',error);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000)};
async function api(path,{method='GET',body}={}){
 if(!auth.currentUser())throw Error('กรุณาเข้าสู่ระบบ Google');
 const token=await auth.idToken();
 const response=await fetch(path,{method,cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Authorization:'Bearer '+token,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||data.reason||'HTTP '+response.status);
 return data;
}
function el(tag,className,text){
 const e=document.createElement(tag);
 if(className)e.className=className;
 if(text!==undefined)e.textContent=esc(text);
 return e;
}
function playerRow(p){
 const tr=document.createElement('tr');
 const info=el('td'),n=el('strong',null,p.name||'ผู้เล่น'),email=el('small',null,p.email||'ไม่มีอีเมลในทะเบียนเดิม');
 info.append(n,email);
 const score=el('td','num',Number(p.score||0).toLocaleString('th-TH'));
 const state=el('td');
 state.append(el('span','pill'+(p.online?' online':''),p.banned?'⛔ ถูกแบน':p.online?'● ออนไลน์':'ออฟไลน์'));
 if(p.banned)state.firstChild.classList.remove('online');
 const actions=el('td'),btn=el('button','edit-btn','แก้ไข');
 btn.type='button';btn.addEventListener('click',()=>openEdit(p));
 const ban=el('button','edit-btn',p.banned?'ปลดแบน':'ระงับ');
 ban.type='button';ban.addEventListener('click',()=>p.banned?unbanPlayer(p.uid):prepareBan(p.uid));
 const group=el('div','moderation-actions');group.append(btn,ban);actions.append(group);
 tr.append(info,score,state,actions);return tr;
}
async function refreshPlayers({append=false}={}){
 if(!permitted||editing)return;
 const start=append?offset:0;
 const query=new URLSearchParams({server,online:onlineOnly?'1':'0',limit:'100',offset:String(start)});
 const response=await api('/api/admin/board/players?'+query);
 if(server!==response.server)return;
 if(!append){$('players-body').replaceChildren();offset=0;}
 for(const player of response.players||[])$('players-body').append(playerRow(player));
 if(!append&&!response.players?.length){
  const tr=document.createElement('tr'),td=el('td',null,'ยังไม่มีผู้เล่นในรายการนี้');td.colSpan=4;tr.append(td);$('players-body').append(tr);
 }
 offset+=response.players?.length||0;
 $('pagination').textContent='แสดง '+offset+' / '+response.total+' รายการ';
 $('load-more').hidden=offset>=response.total;
 $('board-detail').textContent='ผู้เล่นออนไลน์ '+response.online+' คน';
 $('last-refresh').textContent='อัปเดต '+fmtTime(Date.now());
}
async function refreshOverview(){
 if(!permitted)return;
 try{
  // Both the game UI and this dashboard read the same public aggregate endpoint.
  // Roster totals and next reset still require the verified owner session.
  const [freeRoster,vipRoster,counts]=await Promise.all([
    api('/api/admin/board/players?server=free&limit=1'),
    api('/api/admin/board/players?server=vip&limit=1'),
    fetch('/api/online/counts',{cache:'no-store'}).then(async response=>{
      if(!response.ok)throw Error('online_count_unavailable');
      return response.json();
    })
  ]);
  if(!Number.isSafeInteger(counts.free)||counts.free<0||
     !Number.isSafeInteger(counts.vip)||counts.vip<0||
     !Number.isFinite(counts.asOf))throw Error('online_counts_invalid');
  for(const roster of [freeRoster,vipRoster]){
    const key=roster.server;
    $(key+'-player-count').textContent=Number(roster.total).toLocaleString('th-TH');
    $(key+'-online-tag').textContent=Number(counts[key]).toLocaleString('th-TH')+' ออนไลน์';
    $(key+'-next').textContent=fmtTime(roster.nextReset);
  }
  $('online-overview-updated').textContent='🟢 ออนไลน์ตามสัญญาณผู้เล่น 90 วินาทีล่าสุด • Free '+counts.free.toLocaleString('th-TH')+' คน · VIP '+counts.vip.toLocaleString('th-TH')+' คน • เวลา '+fmtTime(counts.asOf);
 }catch(error){
  for(const key of ['free','vip'])$(key+'-online-tag').textContent='— ออนไลน์';
  $('online-overview-updated').textContent='⚠️ ยังอัปเดตจำนวนออนไลน์ไม่ได้';
  throw error;
 }
}
function historyElement(item){
 const box=el('article','history-item');
 box.append(el('strong',null,(item.mode==='auto'?'🕛 อัตโนมัติ':'✋ รีเซ็ตโดยผู้ดูแล')+' • '+fmtTime(item.resetAt)));
 box.append(el('div',null,'🏆 '+(item.name||'ไม่มีผู้ชนะ')+(item.email?' ('+item.email+')':'')+' • '+Number(item.score||0).toLocaleString('th-TH')+' คะแนน'));
 box.append(el('small','muted','ผู้เล่นในฐานข้อมูล '+item.playerCount+' คน'));
 return box;
}
async function refreshHistory(){
 if(!permitted)return;
 const response=await api('/api/admin/board/history?server='+historyServer);
 $('history-list').replaceChildren();
 if(!response.history?.length)$('history-list').append(el('p','muted','ยังไม่มีประวัติรีเซ็ตเซิร์ฟเวอร์นี้'));
 else for(const entry of response.history)$('history-list').append(historyElement(entry));
}
async function refreshAudit(){
 if(!permitted)return;
 const response=await api('/api/admin/board/audit?server='+server);
 $('audit-list').replaceChildren();
 if(!response.actions?.length)$('audit-list').append(el('p','muted','ยังไม่มีประวัติการแก้ไข'));
 else for(const record of response.actions.slice(0,25)){
  const e=el('article','history-item');
  e.append(el('strong',null,fmtTime(record.at)+' • '+record.action));
  e.append(el('div',null,'ผู้ดำเนินการ: '+record.actor+(record.uid?' • ผู้เล่น: '+record.uid:'')));
  $('audit-list').append(e);
 }
}
async function refreshPrices(){
 if(!permitted)return;
 const response=await api('/api/admin/store/prices');
 for(const id of ['vip','shield','win2'])$('price-'+id).value=Number(response.prices?.[id]||0);
}
async function reload(){
 if(!permitted||refreshing||editing||document.visibilityState!=='visible')return;
 refreshing=true;
 const result=await Promise.allSettled([refreshOverview(),refreshPlayers(),refreshAudit(),refreshControlStatus()]);
 const bad=result.find(x=>x.status==='rejected');
 if(bad)toast('โหลดข้อมูลสดไม่สำเร็จ: '+bad.reason.message,true);
 refreshing=false;
}
function selectServer(s){
 if(!['free','vip'].includes(s))return;
 server=s;offset=0;
 for(const b of document.querySelectorAll('.server-tab'))b.classList.toggle('active',b.dataset.server===s);
 Promise.allSettled([refreshPlayers(),refreshAudit()]).then(results=>{
  const bad=results.find(x=>x.status==='rejected');if(bad)toast(bad.reason.message,true);
 });
}
function selectHistory(s){
 historyServer=s;
 for(const b of document.querySelectorAll('.history-tab'))b.classList.toggle('active',b.dataset.history===s);
 refreshHistory().catch(e=>toast(e.message,true));
}
function openEdit(p){
 editing={uid:p.uid,server};
 $('edit-identity').textContent='อีเมล: '+(p.email||'ยังไม่มีข้อมูล')+' • เซิร์ฟเวอร์ '+server.toUpperCase();
 $('edit-name').value=p.name||'';
 $('edit-score').value=Number(p.score||0);
 $('edit-backdrop').hidden=false;
 $('edit-name').focus();
}
function closeEdit(){$('edit-backdrop').hidden=true;editing=null;}
async function manualReset(s){
 if(!permitted)return;
 if(!window.confirm('ยืนยันรีเซ็ตคะแนน '+s.toUpperCase()+' เป็น 0 ทันที? ระบบจะบันทึกผู้ชนะก่อนรีเซ็ต'))return;
 if(!window.confirm('ยืนยันครั้งสุดท้าย: การรีเซ็ตคะแนน '+s.toUpperCase()+' ไม่สามารถย้อนกลับโดยอัตโนมัติได้'))return;
 try{
  const response=await api('/api/admin/board/reset',{method:'POST',body:{server:s,confirm:'RESET'}});
  toast('รีเซ็ต '+s.toUpperCase()+' สำเร็จ • '+(response.winner?.name||'ไม่มีผู้ชนะ')+' • '+(response.winner?.score||0)+' คะแนน');
  await Promise.all([refreshOverview(),refreshPlayers(),refreshHistory(),refreshAudit()]);
 }catch(e){toast('รีเซ็ตไม่สำเร็จ: '+e.message,true);}
}
async function checkLogin(user){
 permitted=false;
 $('dashboard').hidden=true;
 if(!user){
  $('auth-box').hidden=false;$('sign-in').hidden=false;$('sign-out').hidden=true;
  status('● ยังไม่เข้าสู่ระบบ');$('auth-note').textContent='ต้องใช้บัญชีผู้ดูแลที่กำหนดเท่านั้น';return;
 }
 $('sign-out').hidden=false;
 status('● กำลังตรวจสิทธิ์ Google...');
 try{
  const response=await api('/api/admin/session');
  if(!response.admin)throw Error('ไม่มีสิทธิ์ผู้ดูแล');
  permitted=true;$('auth-box').hidden=true;$('dashboard').hidden=false;
  status('● ผู้ดูแลที่ได้รับอนุญาต',true);
  const settled=await Promise.allSettled([refreshOverview(),refreshPlayers(),refreshPrices(),refreshHistory(),refreshAudit(),refreshControlStatus(),refreshBans(),refreshVipTransactions()]);
  const failed=settled.find(r=>r.status==='rejected');
  if(failed)toast('โหลดบางส่วนไม่สำเร็จ: '+failed.reason.message,true);
  if(!tick)tick=setInterval(reload,15000);
 }catch(e){
  status('● ไม่มีสิทธิ์เข้าถึง');$('auth-box').hidden=false;
  $('auth-note').textContent=e.message;$('sign-in').hidden=true;
 }
}

function prepareBan(uid){
 $('ban-uid').value=uid;
 $('ban-reason').focus();
 $('ban-form').scrollIntoView({behavior:'smooth',block:'center'});
}
async function unbanPlayer(uid){
 if(!window.confirm('ยืนยันปลดแบนผู้เล่น '+uid+' ?'))return;
 try{await api('/api/admin/control/ban',{method:'POST',body:{uid,banned:false}});
  toast('ปลดแบนบัญชีสำเร็จ');await Promise.allSettled([refreshBans(),refreshPlayers()]);
 }catch(e){toast('ปลดแบนไม่สำเร็จ: '+e.message,true)}
}
async function refreshControlStatus(){
 if(!permitted)return;
 const response=await api('/api/admin/control/status');
 for(const key of ['free','vip'])$('maintenance-'+key).checked=response.maintenance?.[key]?.enabled===true;
 $('maintenance-status').textContent='บัญชีที่ถูกแบน '+(response.bannedTotal||0)+' คน • ตั้งค่าเซิร์ฟเวอร์แยกอิสระ';
}
async function refreshBans({append=false}={}){
 if(!permitted)return;
 const start=append?bansOffset:0;
 const response=await api('/api/admin/control/bans?offset='+start+'&limit=50');
 if(!append){bansOffset=0;$('ban-list').replaceChildren();}
 for(const b of response.bans||[]){
  const item=el('div','history-item ban-entry');
  const info=el('div','ban-text');
  info.append(el('strong',null,b.uid),el('div',null,'เหตุผล: '+b.reason),el('small','muted',fmtTime(b.at)+' • '+b.actor));
  const unban=el('button','secondary small','ปลดแบน');
  unban.type='button';unban.addEventListener('click',()=>unbanPlayer(b.uid));
  item.append(info,unban);$('ban-list').append(item);
 }
 bansOffset+=(response.bans||[]).length;
 $('bans-count').textContent=bansOffset+' / '+response.total+' รายการ';
 $('more-bans').hidden=bansOffset>=response.total;
 if(response.total===0)$('ban-list').append(el('p','muted','ยังไม่มีบัญชีที่ถูกแบน'));
}
async function toggleMaintenance(which,enabled){
 const input=$('maintenance-'+which);
 if(!window.confirm((enabled?'เปิด':'ปิด')+'โหมดปรับปรุง '+which.toUpperCase()+' ?'+(enabled?' ระบบจะหยุดจับคู่ห้องใหม่ แต่เกมที่เริ่มแล้วเล่นต่อได้':''))){
  input.checked=!enabled;return;
 }
 input.disabled=true;
 try{
  const response=await api('/api/admin/control/maintenance',{method:'POST',body:{server:which,enabled,note:''}});
  if(!response.ok)throw Error(response.reason||'ไม่สำเร็จ');
  toast((enabled?'เปิด':'ปิด')+'โหมดปรับปรุง '+which.toUpperCase()+' สำเร็จ');
 }catch(e){input.checked=!enabled;toast('เปลี่ยนโหมดไม่สำเร็จ: '+e.message,true)}
 finally{input.disabled=false;refreshControlStatus().catch(()=>{})}
}
function vipTransactionRow(entry){
 const tr=document.createElement('tr');
 const identity=el('td');
 identity.append(el('strong',null,entry.order||'—'),el('small',null,'ผู้ซื้อ: '+(entry.buyer||'—')));
 const amount=el('td','num',(Number(entry.amountBaht||0).toLocaleString('th-TH'))+' ฿');
 const state=el('td');
 const labels={pending:'รอชำระ',verifying:'กำลังตรวจ',verified:'ตรวจผ่าน',fulfilling:'กำลังให้สิทธิ์',fulfilled:'ให้สิทธิ์แล้ว',cancelled:'ยกเลิก'};
 state.append(el('span','pill'+(entry.status==='fulfilled'?' online':''),labels[entry.status]||entry.status));
 const at=el('td',null,fmtTime(entry.createdAt));
 tr.append(identity,amount,state,at);return tr;
}
async function refreshVipTransactions({append=false}={}){
 if(!permitted)return;
 const start=append?vipTxnOffset:0;
 const response=await api('/api/admin/payments/vip?offset='+start+'&limit=50');
 if(!append){vipTxnOffset=0;$('vip-transactions-body').replaceChildren();}
 for(const entry of response.orders||[])$('vip-transactions-body').append(vipTransactionRow(entry));
 vipTxnOffset+=(response.orders||[]).length;
 $('vip-transactions-count').textContent=vipTxnOffset+' / '+response.total+' รายการ • เฉพาะ Payment V2';
 $('more-vip-transactions').hidden=vipTxnOffset>=response.total;
 if(response.total===0){
  const tr=el('tr'),td=el('td',null,'ยังไม่มีคำสั่งซื้อ VIP ใน Payment V2');td.colSpan=4;tr.append(td);$('vip-transactions-body').append(tr);
 }
}
const csvCell=value=>{
 let text=String(value??'');
 if(/^[=+\-@\t\r\n]/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
};
function downloadAdminFile(filename,content,mime){
 const blob=new Blob([content],{type:mime}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function exportScores(which,format){
 if(exporting||!permitted)return;
 exporting=true;
 const controls=['free-csv','vip-csv','free-json','vip-json'].map(k=>$('export-'+k));
 controls.forEach(x=>x.disabled=true);
 try{
  const records=[];let offset=0,total=0;
  do{
   const page=await api('/api/admin/board/export?server='+which+'&offset='+offset+'&limit=250');
   if(page.server!==which||!Array.isArray(page.rows))throw Error('ข้อมูลส่งออกไม่ถูกต้อง');
   if(offset===0)total=Number(page.total||0);
   if(page.rows.length===0&&offset<total)throw Error('ข้อมูลส่งออกไม่ครบ');
   records.push(...page.rows);offset+=page.rows.length;
   $('export-status').textContent='กำลังสำรอง '+which.toUpperCase()+' '+offset+' / '+total+' รายการ';
   if(offset>100000)throw Error('ข้อมูลเกินขนาดที่รองรับในหนึ่งไฟล์');
  }while(offset<total);
  const snapshotTime=new Date().toISOString();
  const date=snapshotTime.slice(0,10),filename='snl-scores-'+which+'-'+date+'.'+format;
  if(format==='csv'){
   const headings=['server','uid','email','name','avatar','score','last_seen','joined_at','updated_at'];
   const rows=records.map(p=>[which,p.uid,p.email,p.name,p.avatar,p.score,p.lastSeen,p.joinedAt,p.updatedAt].map(csvCell).join(','));
   downloadAdminFile(filename,'\uFEFF'+headings.join(',')+'\r\n'+rows.join('\r\n'),'text/csv;charset=utf-8');
  }else{
   const winners=await api('/api/admin/board/history?server='+which);
   downloadAdminFile(filename,JSON.stringify({format:'snl-score-backup-v1',server:which,createdAt:snapshotTime,total,players:records,resetHistory:winners.history||[]},null,2),'application/json;charset=utf-8');
  }
  $('export-status').textContent='ดาวน์โหลด '+format.toUpperCase()+' '+records.length+' รายการเรียบร้อย • เก็บไฟล์เป็นความลับ';
  toast('สร้างไฟล์สำรอง '+which.toUpperCase()+' สำเร็จ');
 }catch(e){toast('ส่งออกไม่สำเร็จ: '+e.message,true);$('export-status').textContent='ส่งออกไม่สำเร็จ กรุณาลองใหม่'}
 finally{exporting=false;controls.forEach(x=>x.disabled=false)}
}

$('ban-form').addEventListener('submit',async event=>{
 event.preventDefault();
 const uid=$('ban-uid').value.trim(),reason=$('ban-reason').value.trim();
 if(!uid||!reason)return toast('กรุณากรอก UID และเหตุผล',true);
 if(!window.confirm('ยืนยันแบน UID '+uid+' ทั้ง Free และ VIP?'))return;
 $('ban-submit').disabled=true;
 try{
  const result=await api('/api/admin/control/ban',{method:'POST',body:{uid,banned:true,reason}});
  if(!result.ok)throw Error(result.reason||'ไม่สำเร็จ');
  $('ban-uid').value='';$('ban-reason').value='';
  toast('ระงับบัญชีสำเร็จ');await Promise.allSettled([refreshBans(),refreshPlayers(),refreshControlStatus()]);
 }catch(e){toast('แบนไม่สำเร็จ: '+e.message,true)}
 finally{$('ban-submit').disabled=false}
});
$('refresh-bans').addEventListener('click',()=>refreshBans().catch(e=>toast(e.message,true)));
$('more-bans').addEventListener('click',()=>refreshBans({append:true}).catch(e=>toast(e.message,true)));
for(const key of ['free','vip'])$('maintenance-'+key).addEventListener('change',e=>toggleMaintenance(key,e.target.checked));
$('refresh-vip-transactions').addEventListener('click',()=>refreshVipTransactions().catch(e=>toast(e.message,true)));
$('more-vip-transactions').addEventListener('click',()=>refreshVipTransactions({append:true}).catch(e=>toast(e.message,true)));
for(const which of ['free','vip'])for(const format of ['csv','json'])
 $('export-'+which+'-'+format).addEventListener('click',()=>exportScores(which,format));

$('sign-in').addEventListener('click',async()=>{try{await auth.signIn()}catch(e){toast('เข้าสู่ระบบ Google ไม่สำเร็จ: '+e.message,true)}});
$('sign-out').addEventListener('click',async()=>{await auth.logOut();permitted=false;clearInterval(tick);tick=null});
$('refresh').addEventListener('click',()=>reload().catch(e=>toast(e.message,true)));
$('load-more').addEventListener('click',()=>refreshPlayers({append:true}).catch(e=>toast(e.message,true)));
$('online-only').addEventListener('change',e=>{onlineOnly=e.target.checked;offset=0;refreshPlayers().catch(err=>toast(err.message,true))});
for(const b of document.querySelectorAll('.server-tab'))b.addEventListener('click',()=>selectServer(b.dataset.server));
for(const b of document.querySelectorAll('.history-tab'))b.addEventListener('click',()=>selectHistory(b.dataset.history));
$('reset-free').addEventListener('click',()=>manualReset('free'));
$('reset-vip').addEventListener('click',()=>manualReset('vip'));
$('refresh-history').addEventListener('click',()=>refreshHistory().catch(e=>toast(e.message,true)));
$('refresh-audit').addEventListener('click',()=>refreshAudit().catch(e=>toast(e.message,true)));
$('edit-close').addEventListener('click',closeEdit);
$('edit-backdrop').addEventListener('click',e=>{if(e.target===$('edit-backdrop'))closeEdit()});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&editing)closeEdit()});
$('edit-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!editing)return;
 const score=Number($('edit-score').value),name=$('edit-name').value.trim();
 if(!name||!Number.isSafeInteger(score)||score<0||score>999999999)return toast('ชื่อหรือคะแนนไม่ถูกต้อง',true);
 $('edit-save').disabled=true;
 try{
  await api('/api/admin/board/edit',{method:'POST',body:{server:editing.server,uid:editing.uid,name,score}});
  closeEdit();toast('บันทึกข้อมูลผู้เล่นสำเร็จ');await Promise.all([refreshPlayers(),refreshOverview(),refreshAudit()]);
 }catch(e){toast('บันทึกไม่สำเร็จ: '+e.message,true)}
 finally{$('edit-save').disabled=false}
});
$('prices-form').addEventListener('submit',async event=>{
 event.preventDefault();
 const prices={vip:Number($('price-vip').value),shield:Number($('price-shield').value),win2:Number($('price-win2').value)};
 if(Object.values(prices).some(p=>!Number.isSafeInteger(p)||p<1||p>5000))return toast('ราคาแต่ละรายการต้องเป็นจำนวนเต็ม 1–5,000 บาท',true);
 if(!window.confirm('ยืนยันบันทึกราคาสินค้าใหม่? มีผลเฉพาะคำสั่งซื้อที่สร้างหลังจากนี้'))return;
 $('save-prices').disabled=true;
 try{await api('/api/admin/store/prices',{method:'POST',body:{prices}});toast('บันทึกราคาใหม่สำเร็จ • คำสั่งซื้อเดิมยังคงยอดเดิม');await refreshPrices();}
 catch(e){toast('บันทึกราคาไม่สำเร็จ: '+e.message,true)}
 finally{$('save-prices').disabled=false}
});
(async()=>{try{
 const r=await fetch('/api/config',{cache:'no-store'}),cfg=await r.json();
 if(!r.ok||!cfg.firebase)throw Error('Firebase ยังไม่พร้อม');
 await auth.initialize(cfg.firebase,checkLogin);
}catch(e){status('● ไม่สามารถเชื่อม Google Login');$('auth-note').textContent=e.message}})();
