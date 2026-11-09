// Explicit two-mode provider boundary. No path accepts browser-supplied mode.
// Live mode must additionally pass the independent Worker-side Stage 5 lock
// and verified Firebase owner canary check before it ever calls the provider.
export function providerStageReady(env,mode='synthetic'){
  if(!env||typeof env!=='object')return false;
  if(mode==='synthetic')
    return env.PAYMENTS_ENABLED==='false'&&env.PAYMENT_ROLLOUT==='disabled';
  if(mode==='live-owner-canary')
    return env.PAYMENTS_ENABLED==='true'&&env.PAYMENT_ROLLOUT==='canary'&&
      env.PAYMENT_V2_OWNER_CANARY==='explicitly_approved';
  return false;
}
export const V2_STAGE5_LOCKED=false;
// The owner explicitly authorized building a real payment system. Opening this
// code gate is NOT a public rollout: owner-only canary + separate Cloudflare
// flags, merchant preflight and an actual first bank transaction are still required.
export function liveCheckoutOpen(env,owner){
  if(V2_STAGE5_LOCKED)return {ok:false,reason:'real_transfer_test_pending'};
  if(!owner||!owner.id||!owner.email)return {ok:false,reason:'login_required'};
  if(!providerStageReady(env,'live-owner-canary'))return {ok:false,reason:'canary_not_approved'};
  if(String(owner.email).trim().toLowerCase()!==String(env.ADMIN_EMAIL||'').trim().toLowerCase())
    return {ok:false,reason:'owner_only'};
  return {ok:true};
}
