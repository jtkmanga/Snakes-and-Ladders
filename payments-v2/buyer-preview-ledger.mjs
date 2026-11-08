// A wholly isolated, nonpayable checkout exercise for UI/DB tests.
// NOT a real order/payment state machine. Never import this into actual provider
// checkout, never pass its output to VIP or Inventory Durable Objects.
import {PRODUCTS_V2} from './core.mjs';
const DEMO_ID=/^demo-v2-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VALID_USER=/^[A-Za-z0-9_:-]{4,128}$/;
const MAX_ORDERS_PER_DAY=12;
const ORDER_TTL=15*60*1000;
const LOOKBACK=24*60*60*1000;
const all=(storage,query,...args)=>storage.sql.exec(query,...args).toArray();
const first=(storage,query,...args)=>all(storage,query,...args)[0]||null;
export class PaymentV2BuyerPreviewLedger {
  constructor(storage,{clock=()=>Date.now()}={}){
    if(!storage?.sql||typeof storage.transactionSync!=='function')throw Error('sqlite_required');
    this.s=storage;this.clock=clock;
    this.init();
  }
  init(){
    this.s.sql.exec("CREATE TABLE IF NOT EXISTS buyer_v2_demo_orders (id TEXT PRIMARY KEY,uid TEXT NOT NULL,sku TEXT NOT NULL,amount INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('test_only','sim_fulfilled')) )");
    this.s.sql.exec("CREATE TABLE IF NOT EXISTS buyer_v2_demo_receipts (reference TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE,uid TEXT NOT NULL)");
    this.s.sql.exec("CREATE INDEX IF NOT EXISTS idx_buyer_v2_demo_uid_time ON buyer_v2_demo_orders(uid,created_at)");
  }
  public(o){
    return {
      id:o.id,sku:o.sku,amountBaht:o.amount,
      createdAt:o.created_at,expiresAt:o.expires_at,status:o.status,
      simulation:true,qrPayable:false,providerCalled:false,realRightsGranted:false
    };
  }
  create({uid,sku,id}){
    if(!VALID_USER.test(String(uid||''))||!Object.hasOwn(PRODUCTS_V2,sku)||!DEMO_ID.test(String(id||'')))
      return {ok:false,reason:'invalid_demo_input'};
    const now=this.clock();
    return this.s.transactionSync(()=>{
      const prior=first(this.s,"SELECT * FROM buyer_v2_demo_orders WHERE uid=? AND sku=? AND status='test_only' AND expires_at>? ORDER BY created_at DESC LIMIT 1",uid,sku,now);
      if(prior)return {ok:true,reused:true,order:this.public(prior)};
      const count=Number(first(this.s,'SELECT COUNT(*) AS n FROM buyer_v2_demo_orders WHERE uid=? AND created_at>?',uid,now-LOOKBACK)?.n||0);
      if(count>=MAX_ORDERS_PER_DAY)return {ok:false,reason:'daily_demo_limit'};
      this.s.sql.exec("INSERT INTO buyer_v2_demo_orders(id,uid,sku,amount,created_at,expires_at,status) VALUES(?,?,?,?,?,?,'test_only')",
        id,uid,sku,PRODUCTS_V2[sku].amountBaht,now,now+ORDER_TTL);
      return {ok:true,reused:false,order:this.public(first(this.s,'SELECT * FROM buyer_v2_demo_orders WHERE id=? AND uid=?',id,uid))};
    });
  }
  list({uid}){
    if(!VALID_USER.test(String(uid||'')))return [];
    return all(this.s,'SELECT * FROM buyer_v2_demo_orders WHERE uid=? ORDER BY created_at DESC LIMIT 8',uid)
      .map(o=>this.public(o));
  }
  simulate({uid,id,scenario}){
    if(!VALID_USER.test(String(uid||''))||!DEMO_ID.test(String(id||''))||
      !['approved','unverified','wrong_amount','wrong_receiver','vip_full'].includes(scenario))
      return {ok:false,reason:'invalid_demo_input'};
    return this.s.transactionSync(()=>{
      const o=first(this.s,'SELECT * FROM buyer_v2_demo_orders WHERE id=? AND uid=?',id,uid);
      if(!o)return {ok:false,reason:'not_found'};
      if(o.status==='sim_fulfilled')return {ok:true,alreadyApplied:true,order:this.public(o)};
      if(this.clock()>=o.expires_at)return {ok:false,reason:'demo_expired',order:this.public(o)};
      if(scenario!=='approved'){
        const reasons={unverified:'provider_not_verified',wrong_amount:'amount_mismatch',
          wrong_receiver:'receiver_mismatch',vip_full:'vip_capacity_demo'};
        return {ok:false,reason:reasons[scenario],order:this.public(o)};
      }
      const ref='FAKE-ONLY-'+id;
      const dup=first(this.s,'SELECT order_id FROM buyer_v2_demo_receipts WHERE reference=?',ref);
      if(dup)return {ok:false,reason:'duplicate_mock'};
      this.s.sql.exec('INSERT INTO buyer_v2_demo_receipts(reference,order_id,uid) VALUES(?,?,?)',ref,id,uid);
      this.s.sql.exec("UPDATE buyer_v2_demo_orders SET status='sim_fulfilled' WHERE id=? AND uid=? AND status='test_only'",id,uid);
      return {ok:true,alreadyApplied:false,order:this.public(first(this.s,'SELECT * FROM buyer_v2_demo_orders WHERE id=? AND uid=?',id,uid))};
    });
  }
}
