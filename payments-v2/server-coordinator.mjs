// Private server-only Payment V2 coordinator. NOT connected to live Worker routes.
// Its real provider call MUST remain behind verified Firebase buyer identity,
// a confirmed E-Wallet receiver, separate owner-approved canary gates, and the
// disabled-payment stage. No browser can provide provider results or a receipt hash.
import {verifySlipImageServer} from './slip-image-adapter.mjs';
import {providerStageReady} from './provider-stage.mjs';

const orderForProvider=row=>({
  id:row.id,version:2,status:row.status,sku:row.sku,
  amountBaht:row.amount,createdAt:row.created_at,expiresAt:row.expires_at
});

export async function verifyOrderV2({
  ledger,userId,orderId,bytes,env,mode='synthetic',fetchFn,now=Date.now(),uuid=()=>crypto.randomUUID()
}){
  if(!ledger||typeof userId!=='string'||!userId||typeof orderId!=='string')
    return {ok:false,reason:'invalid_request'};
  if(!providerStageReady(env,mode))
    return {ok:false,reason:'provider_stage_not_authorized'};
  const receiver={accountType:env.MERCHANT_ACCOUNT_TYPE,accountNumber:env.MERCHANT_ACCOUNT_NUMBER};
  if(receiver.accountType!=='02004'||typeof receiver.accountNumber!=='string'||!/^\d{15}$/.test(receiver.accountNumber))
    return {ok:false,reason:'receiver_not_ready'};
  const attemptId=uuid();
  const lock=ledger.beginVerification({id:orderId,uid:userId,attemptId});
  if(!lock.ok)return {ok:false,reason:lock.reason};
  if(lock.alreadyVerified)return {ok:true,alreadyVerified:true};
  let event;
  try{
    event=await verifySlipImageServer({
      env,order:orderForProvider(lock.order),receiver,bytes,mode,
      ...(fetchFn?{fetchFn}:{}),now
    });
  }catch{
    ledger.releaseVerification({id:orderId,uid:userId,attemptId});
    return {ok:false,reason:'provider_or_image_rejected'};
  }
  try{
    const verified=ledger.providerVerified({id:orderId,uid:userId,attemptId,event});
    if(!verified.ok){
      ledger.releaseVerification({id:orderId,uid:userId,attemptId});
      return {ok:false,reason:verified.reason};
    }
    // Save verified order and outbox only; never grant VIP from upload alone.
    return {ok:true,verified:true,entitlementGranted:false};
  }catch{
    // If the SQL transaction failed, its transfer claim was rolled back.
    ledger.releaseVerification({id:orderId,uid:userId,attemptId});
    return {ok:false,reason:'verification_commit_failed'};
  }
}

// Delivery is an independent, retryable operation. 'deliveryKey' is stable for
// the order and MUST be used as the downstream transactionId/receipt key.
// A crash after remote grant but before markFulfilled is safe when remote VIP
// and Inventory are themselves idempotent on transactionId.
export async function deliverVerifiedOrderV2({ledger,userId,orderId,vip,inventory}){
  if(!ledger||typeof userId!=='string'||!userId||typeof orderId!=='string')
    return {ok:false,reason:'invalid_request'};
  const claim=ledger.claimDelivery({id:orderId,uid:userId});
  if(!claim.ok)return {ok:false,reason:claim.reason};
  if(claim.alreadyFulfilled)return {ok:true,alreadyFulfilled:true};
  let result;
  try{
    if(claim.sku==='vip'){
      if(!vip||typeof vip.activateAfterVerifiedPayment!=='function'||typeof vip.reserveForCheckout!=='function')
        throw Error('vip_unavailable');
      result=await vip.activateAfterVerifiedPayment({
        userId,orderId,transactionId:claim.deliveryKey
      });
      if(!result?.ok&&result?.reason==='missing_or_expired_hold'){
        const reservation=await vip.reserveForCheckout({userId,orderId});
        if(reservation?.ok)result=await vip.activateAfterVerifiedPayment({
          userId,orderId,transactionId:claim.deliveryKey
        });
        else result={ok:false,reason:reservation?.reason||'vip_capacity_unavailable'};
      }
    }else if(claim.sku==='shield'||claim.sku==='win2'){
      if(!inventory||typeof inventory.grant!=='function')throw Error('inventory_unavailable');
      result=await inventory.grant({uid:userId,sku:claim.sku,transactionId:claim.deliveryKey});
    }else{
      result={ok:false,reason:'unknown_sku'};
    }
    if(!result?.ok){
      ledger.releaseDelivery({id:orderId,uid:userId,attempt:claim.attempt});
      return {ok:false,reason:result?.reason||'delivery_failed',verifiedButNotFulfilled:true};
    }
    const marked=ledger.markFulfilled({id:orderId,uid:userId,attempt:claim.attempt});
    if(!marked.ok)return {ok:false,reason:'mark_fulfilled_failed',verifiedButNotFulfilled:true};
    return {ok:true,fulfilled:true,alreadyApplied:result.alreadyApplied===true,
      ...(result.expiresAt?{expiresAt:result.expiresAt}:{})};
  }catch{
    // If remote grant committed then crashed, next attempt reuses deliveryKey.
    try{ledger.releaseDelivery({id:orderId,uid:userId,attempt:claim.attempt});}catch{}
    return {ok:false,reason:'delivery_retry_required',verifiedButNotFulfilled:true};
  }
}
