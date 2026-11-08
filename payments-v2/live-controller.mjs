// Real owner-only checkout: requires Cloudflare canary binding, Google owner identity and provider merchant readiness.
// Durable Object owns a distinct globally named payment-v2-paid-ledger-v1
// instance. Never use the fake buyer-preview DO for real payment data.
import {PaymentV2AtomicLedger} from './atomic-ledger.mjs';
import {verifyOrderV2,deliverVerifiedOrderV2} from './server-coordinator.mjs';
import {buildEWalletPromptPayPayload,validateEWalletId} from './ewallet-qr.mjs';
import {liveCheckoutOpen} from './provider-stage.mjs';

function publicOrder(o){
  if(!o)return null;
  return {
    id:o.id,sku:o.sku,amountBaht:o.amount,status:o.status,
    createdAt:o.created_at,expiresAt:o.expires_at,fulfilledAt:o.fulfilled_at||null,
    version:2
  };
}
export class PaymentV2LiveCoordinator {
  constructor(storage,env,{authorize=liveCheckoutOpen,fetchFn}={}){
    this.storage=storage;this.env=env;
    this.authorize=authorize;this.fetchFn=fetchFn;
    this.ledger=new PaymentV2AtomicLedger(storage);
  }
  gate(owner){return this.authorize(this.env,owner);}
  async create({owner,sku,uuid,vip}){
    const gate=this.gate(owner);if(!gate.ok)return gate;
    if(!['shield','win2','vip'].includes(sku))return {ok:false,reason:'unknown_product'};
    // All three server-priced products are available to the verified owner only.
    // Public checkout remains disabled by liveCheckoutOpen().
    if(this.env.MERCHANT_ACCOUNT_TYPE!=='02004'||
      !validateEWalletId(this.env.MERCHANT_ACCOUNT_NUMBER))
      return {ok:false,reason:'receiver_unverified'};
    const creation=this.ledger.createPending({uid:owner.id,sku,uuid});
    if(!creation.ok)return creation;
    if(sku==='vip'){
      if(!vip?.reserveForCheckout){
        this.ledger.cancelPending({id:creation.order.id,uid:owner.id});
        return {ok:false,reason:'vip_unavailable'};
      }
      let reservation;
      try{reservation=await vip.reserveForCheckout({userId:owner.id,orderId:creation.order.id});}
      catch{reservation={ok:false,reason:'vip_backend_unavailable'};}
      if(!reservation?.ok){
        // No payable QR may be returned when the seat is not reserved.
        this.ledger.cancelPending({id:creation.order.id,uid:owner.id});
        return {ok:false,reason:reservation?.reason||'vip_full'};
      }
    }
    return {ok:true,reused:creation.reused===true,order:publicOrder(creation.order)};
  }
  get({owner,id}){
    const gate=this.gate(owner);if(!gate.ok)return gate;
    const row=this.ledger.getOrder({id,uid:owner.id});
    return row?{ok:true,order:publicOrder(row)}:{ok:false,reason:'not_found'};
  }
  recent({owner}){
    const gate=this.gate(owner);if(!gate.ok)return gate;
    const uid=owner.id;
    const rows=this.storage.sql.exec(
      'SELECT * FROM v2_paid_orders WHERE uid=? ORDER BY created_at DESC LIMIT 8',uid
    ).toArray();
    return {ok:true,orders:rows.map(publicOrder)};
  }
  qrPayload({owner,id}){
    const gate=this.gate(owner);if(!gate.ok)return gate;
    const row=this.ledger.getOrder({id,uid:owner.id});
    if(!row)return {ok:false,reason:'not_found'};
    if(row.status!=='pending'||Date.now()>=row.expires_at)return {ok:false,reason:'not_payable'};
    if(this.env.MERCHANT_ACCOUNT_TYPE!=='02004'||!validateEWalletId(this.env.MERCHANT_ACCOUNT_NUMBER))
      return {ok:false,reason:'receiver_unverified'};
    return {ok:true,payload:buildEWalletPromptPayPayload({
      accountNumber:this.env.MERCHANT_ACCOUNT_NUMBER,amountBaht:row.amount
    }),order:publicOrder(row)};
  }
  async verify({owner,id,bytes,vip,inventory}){
    const gate=this.gate(owner);if(!gate.ok)return gate;
    const v2row=this.ledger.getOrder({id,uid:owner.id});
    if(!v2row)return {ok:false,reason:'not_found'};
    if(!(bytes instanceof Uint8Array)||bytes.byteLength<8||bytes.byteLength>4*1024*1024)
      return {ok:false,reason:'invalid_image'};
    try{
      const verified=await verifyOrderV2({
        ledger:this.ledger,userId:owner.id,orderId:id,bytes,
        env:this.env,mode:'live-owner-canary',
        ...(this.fetchFn?{fetchFn:this.fetchFn}:{})
      });
      if(!verified.ok)return verified;
      const delivered=await deliverVerifiedOrderV2({
        ledger:this.ledger,userId:owner.id,orderId:id,vip,inventory
      });
      if(!delivered.ok)return {...delivered,verifiedButNotFulfilled:true};
      return {...delivered,order:publicOrder(this.ledger.getOrder({id,uid:owner.id}))};
    }finally{
      // Never leave a slip image stored on the Durable Object.
      bytes.fill(0);
    }
  }
  async reconcile({owner,id,vip,inventory}){
    const gate=this.gate(owner);if(!gate.ok)return gate;
    const row=this.ledger.getOrder({id,uid:owner.id});
    if(!row)return {ok:false,reason:'not_found'};
    if(row.status==='fulfilled')return {ok:true,alreadyFulfilled:true,order:publicOrder(row)};
    if(!['verified','fulfilling'].includes(row.status))
      return {ok:false,reason:'not_verified'};
    const delivered=await deliverVerifiedOrderV2({ledger:this.ledger,userId:owner.id,orderId:id,vip,inventory});
    return {...delivered,order:publicOrder(this.ledger.getOrder({id,uid:owner.id}))};
  }
}
