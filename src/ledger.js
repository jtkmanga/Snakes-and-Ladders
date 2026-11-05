import { DurableObject } from 'cloudflare:workers';
import {PRODUCTS,ORDER_LIFETIME_MS} from './payments.js';
export class PaymentLedger extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, sku TEXT NOT NULL, amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL, lock_until INTEGER NOT NULL DEFAULT 0,
      tx_hash TEXT, fulfilled_at INTEGER
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS transfers (fingerprint TEXT PRIMARY KEY, order_id TEXT NOT NULL)`);
  }
  get(id,uid){
    const rows=this.ctx.storage.sql.exec('SELECT * FROM orders WHERE id=? AND uid=?',id,uid).toArray();
    return rows[0]||null;
  }
  async create({id,uid,sku}){
    const p=PRODUCTS[sku];if(!p||!uid||!/^order-[a-f0-9-]{36}$/.test(id))return {ok:false,reason:'invalid_order'};
    const now=Date.now(),rateKey=`rate:${uid}`;
    let rate=this.ctx.storage.kv.get(rateKey)||{at:now,count:0};
    if(now-rate.at>3_600_000)rate={at:now,count:0};
    if(rate.count>=8)return {ok:false,reason:'rate_limited'};
    const existing=this.ctx.storage.sql.exec("SELECT * FROM orders WHERE uid=? AND sku=? AND status IN ('pending','verifying','verified') AND expires_at>? ORDER BY created_at DESC LIMIT 1",uid,sku,now).toArray()[0];
    if(existing)return {ok:true,order:existing,reused:true};
    this.ctx.storage.sql.exec('INSERT INTO orders (id,uid,sku,amount,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?)',id,uid,sku,p.amount,now,now+ORDER_LIFETIME_MS,'pending');
    rate.count++;this.ctx.storage.kv.put(rateKey,rate);
    return {ok:true,order:this.get(id,uid)};
  }
  takeVerification({id,uid}){
    const order=this.get(id,uid),now=Date.now();
    if(!order)return {ok:false,reason:'missing_order'};
    if(order.status==='verified'||order.status==='fulfilled')return {ok:true,alreadyPaid:true,order};
    if(order.expires_at<=now)return {ok:false,reason:'order_expired'};
    if(order.status==='verifying'&&order.lock_until>now)return {ok:false,reason:'verification_in_progress'};
    this.ctx.storage.sql.exec("UPDATE orders SET status='verifying',lock_until=? WHERE id=?",now+35_000,id);
    return {ok:true,order:this.get(id,uid)};
  }
  unlock({id,uid}){
    this.ctx.storage.sql.exec("UPDATE orders SET status='pending',lock_until=0 WHERE id=? AND uid=? AND status='verifying'",id,uid);
  }
  recordVerified({id,uid,hash}){
    const order=this.get(id,uid);
    if(!order||!hash||hash.length!==64)return {ok:false,reason:'invalid_order'};
    if(order.status==='fulfilled'||order.status==='verified')return {ok:order.tx_hash===hash,reason:'different_slip'};
    if(order.status!=='verifying'||Date.now()>order.expires_at)return {ok:false,reason:'verification_expired'};
    // A single SQL transaction prevents using the same verified bank transfer for any other order.
    let output;
    this.ctx.storage.transactionSync(()=>{
      const previous=this.ctx.storage.sql.exec('SELECT order_id FROM transfers WHERE fingerprint=?',hash).toArray()[0];
      if(previous&&previous.order_id!==id){output={ok:false,reason:'duplicate_transfer'};return;}
      if(!previous)this.ctx.storage.sql.exec('INSERT INTO transfers (fingerprint,order_id) VALUES (?,?)',hash,id);
      this.ctx.storage.sql.exec("UPDATE orders SET status='verified',tx_hash=?,lock_until=0 WHERE id=? AND uid=?",hash,id,uid);
      output={ok:true};
    });
    return output;
  }
  markFulfilled({id,uid}){
    const order=this.get(id,uid);
    if(!order)return {ok:false};
    if(order.status==='fulfilled')return {ok:true,alreadyApplied:true};
    if(order.status!=='verified')return {ok:false};
    this.ctx.storage.sql.exec("UPDATE orders SET status='fulfilled',fulfilled_at=? WHERE id=? AND uid=?",Date.now(),id,uid);
    return {ok:true};
  }
}
export class Inventory extends DurableObject {
  async getItems(uid){
    const all=this.ctx.storage.kv.get(`inventory:${uid}`)||{};
    return {win2:all.win2>Date.now()?all.win2:0,shield:all.shield>Date.now()?all.shield:0};
  }
  async grant({uid,sku,transactionId}){
    if(!uid||!['win2','shield'].includes(sku)||!transactionId)return {ok:false};
    const previous=this.ctx.storage.kv.get(`inventory:receipt:${transactionId}`);
    if(previous)return previous.uid===uid&&previous.sku===sku?
      {ok:true,alreadyApplied:true,expiresAt:previous.expiresAt}:{ok:false,reason:'duplicate_transaction'};
    const all=this.ctx.storage.kv.get(`inventory:${uid}`)||{};
    const expiry=Math.max(Date.now(),all[sku]||0)+86_400_000;
    all[sku]=expiry;
    this.ctx.storage.kv.put(`inventory:${uid}`,all);
    this.ctx.storage.kv.put(`inventory:receipt:${transactionId}`,{uid,sku,expiresAt:expiry});
    return {ok:true,expiresAt:expiry};
  }
}
