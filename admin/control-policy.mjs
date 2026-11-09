// Global game moderation and server maintenance; storage is the existing Inventory DO.
// Only a trusted Worker route that verifies the Firebase admin is permitted to mutate.
const UID=/^[A-Za-z0-9_:-]{1,128}$/;
const SERVER=new Set(['free','vip']);
const MAX_REASON=160;
const MAX_BANS=5000;
function validActor(v){return typeof v==='string'&&v.length>=3&&v.length<=254;}
function reasonText(v){
 if(typeof v!=='string')return null;
 const clean=v.trim().normalize('NFC');
 return clean.length<=MAX_REASON&&!/[\x00-\x1f\x7f<>]/.test(clean)?clean:null;
}
const normalizeRecord=(v)=>v&&v.active===true&&typeof v.uid==='string'?v:null;
export class GameControlPolicy{
 constructor(kv,{clock=()=>Date.now()}={}){
  if(!kv?.get||!kv?.put)throw Error('kv_required');
  this.kv=kv;this.clock=clock;
 }
 ban(uid){if(!UID.test(String(uid||'')))return null;return normalizeRecord(this.kv.get('control:ban:'+uid));}
 maintenance(server){
  if(!SERVER.has(server))return {enabled:false};
  const m=this.kv.get('control:maintenance:'+server);
  return m&&m.enabled===true?m:{enabled:false,server};
 }
 access({uid,server,ignoreMaintenance=false}){
  if(!UID.test(String(uid||''))||!SERVER.has(server))return {allowed:false,code:'invalid_context'};
  const b=this.ban(uid);
  if(b)return {allowed:false,code:'banned'};
  if(!ignoreMaintenance&&this.maintenance(server).enabled)return {allowed:false,code:'maintenance'};
  return {allowed:true,code:'ok'};
 }
 index(){return this.kv.get('control:ban-index')||[];}
 audits(){return this.kv.get('control:audit')||[];}
 audit(actor,action,uid,detail){
  const entry={at:this.clock(),actor,action,uid:uid||null,detail:String(detail||'').slice(0,170)};
  this.kv.put('control:audit',[entry,...this.audits()].slice(0,300));
 }
 setBan({uid,banned,reason='',actor}){
  if(!UID.test(String(uid||''))||typeof banned!=='boolean'||!validActor(actor))return {ok:false,reason:'bad_input'};
  const clean=reasonText(reason);
  if(clean===null||(banned&&!clean))return {ok:false,reason:'bad_reason'};
  const old=this.ban(uid),index=this.index();
  if(banned){
   if(!old&&index.length>=MAX_BANS)return {ok:false,reason:'ban_limit'};
   const entry={uid,active:true,reason:clean,actor,at:this.clock()};
   // Source of truth is the per-user key; index is for paginated admin display.
   this.kv.put('control:ban:'+uid,entry);
   this.kv.put('control:ban-index',[entry,...index.filter(p=>p.uid!==uid)]);
   this.audit(actor,old?'update_ban':'ban',uid,clean);
   return {ok:true,banned:true,entry};
  }
  this.kv.put('control:ban:'+uid,{uid,active:false,at:this.clock()});
  this.kv.put('control:ban-index',index.filter(p=>p.uid!==uid));
  this.audit(actor,'unban',uid,clean);
  return {ok:true,banned:false};
 }
 setMaintenance({server,enabled,note='',actor}){
  if(!SERVER.has(server)||typeof enabled!=='boolean'||!validActor(actor))return {ok:false,reason:'bad_input'};
  const clean=reasonText(note);
  if(clean===null)return {ok:false,reason:'bad_note'};
  const record={server,enabled,note:clean,actor,at:this.clock()};
  this.kv.put('control:maintenance:'+server,record);
  this.audit(actor,enabled?'maintenance_on':'maintenance_off',null,server+':'+clean);
  return {ok:true,maintenance:record};
 }
 getState(){
  return {free:this.maintenance('free'),vip:this.maintenance('vip'),bannedTotal:this.index().length};
 }
 listBans({offset=0,limit=100}={}){
  const n=Math.min(100,Math.max(1,Number(limit)||100)),o=Math.max(0,Math.trunc(Number(offset)||0)),all=this.index();
  return {total:all.length,bans:all.slice(o,o+n).map(({uid,reason,at,actor})=>({uid,reason,at,actor}))};
 }
 listAudit({limit=50}={}){return this.audits().slice(0,Math.min(100,Math.max(1,Number(limit)||50)));}
 bansForUids(uids){
  if(!Array.isArray(uids)||uids.length>300)return {};
  const out={};
  for(const uid of uids)if(UID.test(String(uid||'')))out[uid]=Boolean(this.ban(uid));
  return out;
 }
}
