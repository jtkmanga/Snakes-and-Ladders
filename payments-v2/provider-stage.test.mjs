import test from 'node:test';
import assert from 'node:assert/strict';
import {V2_STAGE5_LOCKED,liveCheckoutOpen,providerStageReady} from './provider-stage.mjs';

const base={ADMIN_EMAIL:'owner@example.org',MERCHANT_ACCOUNT_TYPE:'02004',
 MERCHANT_ACCOUNT_NUMBER:'000000000000000'};
test('live canary only opens for owner with all three explicit Cloudflare gates',()=>{
 assert.equal(V2_STAGE5_LOCKED,false);
 for(const env of [
  {...base,PAYMENTS_ENABLED:'false',PAYMENT_ROLLOUT:'disabled'},
  {...base,PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'canary'},
  {...base,PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'public',PAYMENT_V2_OWNER_CANARY:'explicitly_approved'}
 ]){
  assert.equal(liveCheckoutOpen(env,{id:'testOwner',email:'owner@example.org'}).ok,false);
  assert.equal(liveCheckoutOpen(env,{id:'testOther',email:'other@example.org'}).ok,false);
 }
 const ownerCanary={...base,PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'canary',PAYMENT_V2_OWNER_CANARY:'explicitly_approved'};
 assert.equal(liveCheckoutOpen(ownerCanary,{id:'testOwner',email:'owner@example.org'}).ok,true);
 assert.equal(liveCheckoutOpen(ownerCanary,{id:'testOther',email:'other@example.org'}).ok,false);
});
test('mock verification must not accept enabled real payment flags',()=>{
 assert.equal(providerStageReady({PAYMENTS_ENABLED:'false',PAYMENT_ROLLOUT:'disabled'},'synthetic'),true);
 assert.equal(providerStageReady({PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'canary'},'synthetic'),false);
 assert.equal(providerStageReady({PAYMENTS_ENABLED:'false',PAYMENT_ROLLOUT:'disabled'},'live-owner-canary'),false);
 assert.equal(providerStageReady({PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'canary'},'live-owner-canary'),false);
 assert.equal(providerStageReady({PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'canary',PAYMENT_V2_OWNER_CANARY:'explicitly_approved'},'live-owner-canary'),true);
 assert.equal(providerStageReady({PAYMENTS_ENABLED:'true',PAYMENT_ROLLOUT:'public',PAYMENT_V2_OWNER_CANARY:'explicitly_approved'},'live-owner-canary'),false);
 assert.equal(providerStageReady({},'unexpected'),false);
});
