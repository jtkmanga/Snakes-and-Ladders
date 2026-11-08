// The first live-money pilot is restricted to a single low-price item for the owner.
// A positive Slip2Go account-info response is necessary, but not sufficient, for
// a payment to be considered complete. A bank slip still must pass verification.
import {slip2goAccountInfo} from './slip2go-admin.js';
import {PRODUCTS} from './payments.js';

export function allowedCanaryItem(env,sku){
  if(!PRODUCTS[sku])return false;
  return env.PAYMENT_ROLLOUT!=='canary'||sku==='shield';
}
export function validateMerchantReadiness(account,env,now=Date.now()){
  const expected=String(env.MERCHANT_DISPLAY_NAME||'').trim().normalize('NFC').toLowerCase();
  const observed=String(account?.shopName||'').trim().normalize('NFC').toLowerCase();
  if(!expected||!observed||expected!==observed)
    return {ok:false,reason:'merchant_name_mismatch'};
  const expiration=Date.parse(account.packageExpiredDate);
  if(!Number.isFinite(expiration)||expiration<=now)
    return {ok:false,reason:'merchant_package_expired_or_unknown'};
  const tokens=Number(account.tokenRemaining),cost=Number(account.tokenPerSlip);
  const credit=Number(account.creditRemaining);
  const tokenUsable=Number.isFinite(tokens)&&tokens>0&&(cost===0||!Number.isFinite(cost)||tokens>=cost);
  const creditUsable=account.checkSlipByCredit===true&&Number.isFinite(credit)&&credit>0;
  if(!tokenUsable&&!creditUsable)return {ok:false,reason:'merchant_no_verification_quota'};
  return {ok:true};
}
export async function preflightBeforeMoney(env,providerFetch=fetch){
  const account=await slip2goAccountInfo(env,providerFetch);
  return validateMerchantReadiness(account,env);
}
