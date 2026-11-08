// Snakes & Ladders administration: durable, per-server SQL registry.
// SQL state (not a browser cache) is authoritative for scores & winner history.
export const THAI_OFFSET_MS=7*3600000;
export const DAY_MS=86400000;
export const ONLINE_TTL_MS=90000;
export const MAX_SCORE=999999999;
export function nextResetAt(now,server){
 if(!Number.isFinite(now)||!['free','vip'].includes(server))throw Error('invalid_schedule');
 let localDay=Math.floor((now+THAI_OFFSET_MS)/DAY_MS)+1;
 if(server==='free'){
   while(new Date(localDay*DAY_MS).getUTCDay()!==0)localDay++;
 }
 return localDay*DAY_MS-THAI_OFFSET_MS;
}
const validUid=id=>typeof id==='string'&&/^[a-zA-Z0-9_:-]{1,128}$/.test(id);
const normalName=name=>typeof name==='string'?name.trim().normalize('NFC'):'';
const validName=name=>name.length>0&&name.length<=18&&!/[<>\x00-\x1f\x7f]/.test(name);
export class AdminBoard {
 constructor(storage){
  if(!storage?.sql)throw Error('sql_storage_required');
  this.s=storage;
  this.s.sql.exec("CREATE TABLE IF NOT EXISTS admin_players (uid TEXT PRIMARY KEY, email TEXT, name TEXT NOT NULL, avatar INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  this.s.sql.exec("CREATE INDEX IF NOT EXISTS idx_admin_score ON admin_players(score DESC,uid ASC)");
  this.s.sql.exec("CREATE INDEX IF NOT EXISTS idx_admin_online ON admin_players(last_seen DESC)");
  this.s.sql.exec("CREATE TABLE IF NOT EXISTS admin_resets (id INTEGER PRIMARY KEY AUTOINCREMENT, reset_at INTEGER NOT NULL, performed_at INTEGER NOT NULL, mode TEXT NOT NULL, actor TEXT NOT NULL, winner_uid TEXT, winner_name TEXT, winner_email TEXT, winner_score INTEGER NOT NULL DEFAULT 0, player_count INTEGER NOT NULL)");
  this.s.sql.exec("CREATE TABLE IF NOT EXISTS admin_awards (award_id TEXT PRIMARY KEY,uid TEXT NOT NULL,points INTEGER NOT NULL,at INTEGER NOT NULL)");
  this.s.sql.exec("CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target_uid TEXT, detail TEXT NOT NULL)");
 }
 rows(query,...args){return this.s.sql.exec(query,...args).toArray();}
 one(query,...args){return this.rows(query,...args)[0]||null;}
 seed(leaders=[],now=Date.now()){
  for(const p of leaders)if(validUid(p.id)&&Number.isSafeInteger(p.score)&&p.score>=0){
   this.s.sql.exec("INSERT OR IGNORE INTO admin_players(uid,email,name,avatar,score,last_seen,joined_at,updated_at) VALUES(?,?,?,?,?,0,?,?)",p.id,null,validName(normalName(p.name))?normalName(p.name):'ผู้เล่น',Number.isInteger(p.avatar)?p.avatar:0,p.score,now,now);
  }
 }
 touch({id,email,name,avatar=0,online=false},now=Date.now()){
  if(!validUid(id))return false;
  const n=normalName(name),knownEmail=typeof email==='string'&&email.length<=254?email.trim().toLowerCase():null;
  if(!validName(n))return false;
  this.s.sql.exec("INSERT INTO admin_players(uid,email,name,avatar,score,last_seen,joined_at,updated_at) VALUES(?,?,?,?,0,?,?,?) ON CONFLICT(uid) DO UPDATE SET email=COALESCE(excluded.email,admin_players.email),name=excluded.name,avatar=excluded.avatar,last_seen=CASE WHEN ? THEN excluded.last_seen ELSE admin_players.last_seen END,updated_at=excluded.updated_at",
   id,knownEmail,n,Number.isInteger(avatar)?avatar:0,online?now:0,now,now,online?1:0);
  return true;
 }
 creditOnce({awardId,id,name,avatar,points},now=Date.now()){
  if(typeof awardId!=='string'||awardId.length>160||!validUid(id)||!Number.isSafeInteger(points)||points<=0||points>200)return false;
  return this.s.transactionSync(()=>{
   if(this.one('SELECT award_id FROM admin_awards WHERE award_id=?',awardId))return false;
   if(!this.touch({id,name,avatar,online:false},now))return false;
   this.s.sql.exec('INSERT INTO admin_awards(award_id,uid,points,at) VALUES(?,?,?,?)',awardId,id,points,now);
   this.s.sql.exec('UPDATE admin_players SET score=MIN(?,score+?),updated_at=? WHERE uid=?',MAX_SCORE,points,now,id);
   return true;
  });
 }
 award({id,name,avatar,points},now=Date.now()){
  if(!validUid(id)||!Number.isSafeInteger(points)||points<1||points>200)return false;
  this.touch({id,name,avatar,online:false},now);
  this.s.sql.exec("UPDATE admin_players SET score=MIN(?,score+?),updated_at=? WHERE uid=?",MAX_SCORE,points,now,id);
  return true;
 }
 leaders(){return this.rows("SELECT uid AS id,name,avatar,score FROM admin_players WHERE score>0 ORDER BY score DESC,uid ASC LIMIT 50");}
 players({onlineOnly=false,limit=150,offset=0,now=Date.now()}={}){
  const size=Math.min(300,Math.max(1,Number(limit)||150)),skip=Math.max(0,Number(offset)||0);
  const cutoff=now-ONLINE_TTL_MS;
  const where=onlineOnly?' WHERE last_seen>=?':'';
  const rows=this.rows("SELECT uid,email,name,avatar,score,last_seen AS lastSeen FROM admin_players"+where+" ORDER BY CASE WHEN last_seen>=? THEN 0 ELSE 1 END,score DESC,last_seen DESC LIMIT ? OFFSET ?",...(onlineOnly?[cutoff,cutoff,size,skip]:[cutoff,size,skip]));
  const total=this.one("SELECT COUNT(*) AS n FROM admin_players"+where,...(onlineOnly?[cutoff]:[]))?.n||0;
  const online=this.one("SELECT COUNT(*) AS n FROM admin_players WHERE last_seen>=?",cutoff)?.n||0;
  return {players:rows.map(p=>({...p,online:p.lastSeen>=cutoff})),total,online};
 }
 edit({uid,name,score},actor,now=Date.now()){
  if(!validUid(uid)||typeof actor!=='string')return {ok:false,reason:'invalid_identity'};
  if(name!==undefined&&(!validName(normalName(name))))return {ok:false,reason:'invalid_name'};
  if(score!==undefined&&(!Number.isSafeInteger(score)||score<0||score>MAX_SCORE))
    return {ok:false,reason:'invalid_score'};
  const previous=this.one("SELECT * FROM admin_players WHERE uid=?",uid);
  if(!previous)return {ok:false,reason:'player_not_registered'};
  const newName=name===undefined?previous.name:normalName(name);
  const newScore=score===undefined?previous.score:score;
  this.s.transactionSync(()=>{
   this.s.sql.exec('UPDATE admin_players SET name=?,score=?,updated_at=? WHERE uid=?',newName,newScore,now,uid);
   this.audit(actor,'edit_player',uid,JSON.stringify({oldScore:previous.score,newScore,renamed:newName!==previous.name}),now);
  });
  return {ok:true,player:this.one("SELECT uid,email,name,avatar,score,last_seen AS lastSeen FROM admin_players WHERE uid=?",uid)};
 }
 rename({id,name},now=Date.now()){
  if(!validUid(id)||!validName(normalName(name)))return false;
  this.s.sql.exec('UPDATE admin_players SET name=?,updated_at=? WHERE uid=?',normalName(name),now,id);
  return true;
 }
 audit(actor,action,uid,detail,now=Date.now()){
  this.s.sql.exec('INSERT INTO admin_audit(at,actor,action,target_uid,detail) VALUES(?,?,?,?,?)',now,actor,action,uid||null,String(detail||'').slice(0,350));
 }
 reset({at=Date.now(),mode='manual',actor='system',server='free'}={}){
  const top=this.one("SELECT uid,name,email,score FROM admin_players WHERE score>0 ORDER BY score DESC,uid ASC LIMIT 1");
  const count=this.one('SELECT COUNT(*) AS n FROM admin_players')?.n||0;
  this.s.transactionSync(()=>{
   this.s.sql.exec("INSERT INTO admin_resets(reset_at,performed_at,mode,actor,winner_uid,winner_name,winner_email,winner_score,player_count) VALUES(?,?,?,?,?,?,?,?,?)",
    at,Date.now(),mode,actor,top?.uid||null,top?.name||null,top?.email||null,top?.score||0,count);
   this.s.sql.exec('UPDATE admin_players SET score=0,updated_at=?',Date.now());
   this.audit(actor,'reset_'+server,null,JSON.stringify({mode,winner:top?.uid||null}),at);
  });
  return {ok:true,mode,server,winner:top||null,playerCount:count,at};
 }
 history(limit=40){return this.rows('SELECT reset_at AS resetAt,performed_at AS performedAt,mode,actor,winner_uid AS uid,winner_name AS name,winner_email AS email,winner_score AS score,player_count AS playerCount FROM admin_resets ORDER BY id DESC LIMIT ?',Math.min(100,Math.max(1,Number(limit)||40)));}
 audits(limit=30){return this.rows('SELECT at,actor,action,target_uid AS uid,detail FROM admin_audit ORDER BY id DESC LIMIT ?',Math.min(100,Math.max(1,Number(limit)||30)));}
}
