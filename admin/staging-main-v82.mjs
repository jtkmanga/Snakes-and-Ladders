import {AdminBoard,nextResetAt} from './admin/admin-board.mjs';
import {serveStatic} from './static.js';
import {readSlipImageRequest,publicSlipPreflightResult,SlipUploadError} from './payments-v2/receipt-upload.mjs';
import { DurableObject } from 'cloudflare:workers';
import { getAuthorizedUser, requireSameOrigin } from './security.js';
import { PRODUCTS, paymentConfigured, paymentPublicEnabled, paymentRolloutAllowed, paymentReadiness, verifySlip, transferFingerprint } from './payments.js';
import { createPromptPayPayloadForReceiver,crc16CcittFalse } from './promptpay.js';
import {allowedCanaryItem,preflightBeforeMoney,validateMerchantReadiness} from './payment-canary.js';
import { adminAllowed, validSlipReference, slip2goAccountInfo, slip2goSlipHistory, Slip2GoAdminError } from './slip2go-admin.js';
import qrcode from './vendor/qrcode.mjs';
import {liveCheckoutOpen,V2_STAGE5_LOCKED} from './payments-v2/provider-stage.mjs';
export { PaymentLedger, Inventory } from './ledger.js';
import { AVATARS, LUCKY_PRIZES, VIP_LIMIT, VIP_DURATION_MS, createGame, executeRoll, advance, randomInt, TURN_MS } from './rules.js';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const clampName=name=>String(name||'ผู้เล่น').trim().replace(/[<>\x00-\x1f]/g,'').slice(0,18)||'ผู้เล่น';
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_:-]{1,128}$/.test(id);
const validRoom=id=>typeof id==='string'&&/^room-[a-f0-9-]{36}$/.test(id);
const publicOrder=o=>({id:o.id,sku:o.sku,amount:o.amount,status:o.status,createdAt:o.created_at,expiresAt:o.expires_at,fulfilledAt:o.fulfilled_at||null});
async function fulfillOrder(order,user,env){
  if(!order||order.uid!==user.id||!['verified','fulfilled'].includes(order.status))return json({error:'ยังไม่ได้ตรวจสอบการจ่ายเงิน'},409);
  if(order.status==='fulfilled')return json({ok:true,order:publicOrder(order)});
  try{
    const receipt=order.tx_hash;
    let result=order.sku==='vip'
      ? await env.VIP.get(env.VIP.idFromName('vip-memberships-v1')).activateAfterVerifiedPayment({userId:user.id,orderId:order.id,transactionId:receipt})
      : await env.ITEMS.get(env.ITEMS.idFromName('inventory-v1')).grant({uid:user.id,sku:order.sku,transactionId:receipt});
    // A verified bank transfer might settle just as its 15-minute VIP seat hold expires.
    // Recover the exact verified order only if a fresh seat is available.
    if(!result.ok&&order.sku==='vip'&&result.reason==='missing_or_expired_hold'){
      const vip=env.VIP.get(env.VIP.idFromName('vip-memberships-v1'));
      const renewed=await vip.reserveForCheckout({userId:user.id,orderId:order.id});
      if(renewed.ok)result=await vip.activateAfterVerifiedPayment({userId:user.id,orderId:order.id,transactionId:receipt});
    }
    if(!result.ok)return json({error:'ตรวจสอบการจ่ายเงินผ่านแล้วแต่ยังไม่สามารถเปิดสิทธิ์ได้ โปรดตรวจสถานะหรือแจ้งผู้ดูแล อย่าโอนเงินซ้ำ',status:'verified_not_fulfilled',orderId:order.id},409);
    const payments=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-ledger-v1'));
    const marked=await payments.markFulfilled({id:order.id,uid:user.id});
    if(!marked?.ok)return json({error:'เปิดสิทธิ์แล้ว แต่ยังยืนยันสถานะคำสั่งซื้อไม่สำเร็จ กรุณาตรวจสถานะอีกครั้ง ห้ามโอนซ้ำ',status:'verified_not_fulfilled',orderId:order.id},503);
    return json({ok:true,expiresAt:result.expiresAt,order:publicOrder(await payments.get(order.id,user.id))});
  }catch(e){console.error('fulfillment failed',String(e?.message||e).slice(0,80));return json({error:'ชำระเงินตรวจผ่านแล้ว แต่การเปิดสิทธิ์ยังไม่สำเร็จ โปรดติดต่อผู้ดูแลพร้อมเลขคำสั่งซื้อ',status:'verified_not_fulfilled'},503);}
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    // PAYMENT_REBUILD_V2_DISABLED: old payment endpoints are permanently unavailable.
    // Historic ledger and VIP entitlements remain preserved for audit and future migration.
    if(url.pathname==='/api/payments/v2/status' && request.method==='GET')
      return json({version:2,stage:'preflight',acceptingPayments:false,orderCreation:false,providerVerified:false,mode:'maintenance'},200);
    // PAYMENT_V2_PREFLIGHT_ADMIN_ONLY: no order creation, no real-money QR.
    // PAYMENT_V2_AUTH_COMPARE_READ_ONLY: owner-only and never creates orders or QR.
    if(url.pathname==='/api/payments/v2/auth-compare'){
      if(request.method!=='GET')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'Sign in required'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      const key=env.SLIP2GO_V2_SECRET;
      if(typeof key!=='string'||!key)return json({ok:false,reason:'missing_v2_secret'},503);
      if(key!==key.trim()||/[\r\n\0-\x1f\x7f]/.test(key)||/^(?:Bearer|Basic)\s/i.test(key)||
          /^["']|["']$/.test(key))return json({ok:false,reason:'credential_format'},503);
      const validCodes=new Set(['200001','401001','401002','401003','401004','401005','401006','401007','429000','500500','500503']);
      const probe=async authorization=>{
        try{
          const response=await fetch('https://connect.slip2go.com/api/account/info',{
            method:'GET',headers:{Authorization:authorization,Accept:'application/json'},
            redirect:'manual',signal:AbortSignal.timeout(10000)
          });
          const payload=await response.json().catch(()=>null);
          const code=typeof payload?.code==='string'&&validCodes.has(payload.code)?payload.code:'unexpected';
          const passed=response.ok&&code==='200001'&&payload?.data&&typeof payload.data==='object'&&!Array.isArray(payload.data);
          return {authenticated:Boolean(passed),providerCode:code,httpStatus:response.status};
        }catch{return {authenticated:false,providerCode:null,httpStatus:null,reason:'network_or_timeout'}}
      };
      const direct=await probe(key);
      const bearer=direct.providerCode==='401001'&&!direct.authenticated?await probe('Bearer '+key):null;
      const verdict=direct.authenticated?'direct_authenticated':
        bearer?.authenticated?'legacy_bearer_authenticated':
        direct.providerCode==='401001'?'neither_authenticated_or_provider_rejected':'no_bearer_probe_required';
      return json({ok:Boolean(direct.authenticated||bearer?.authenticated),testMode:'real_read_only',
        direct,bearer,verdict,acceptingPayments:false,orderCreation:false,qrCreated:false},200);
    }
    // V2_STAGE5_ORDER_ROUTES: complete path staged but globally locked until owner approves a real transfer.
    if(url.pathname==='/api/payments/v2/live/status'){
      if(request.method!=='GET')return json({error:'Method not allowed'},405);
      return json({version:2,staged:true,stage5Locked:V2_STAGE5_LOCKED,
        acceptingPayments:!V2_STAGE5_LOCKED&&env.PAYMENTS_ENABLED==='true'&&env.PAYMENT_ROLLOUT==='canary',realTransferTestRequired:true},200);
    }
    if(url.pathname==='/api/payments/v2/live/orders'||url.pathname.startsWith('/api/payments/v2/live/orders/')){
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const buyer=await getAuthorizedUser(request,env);
      if(!buyer)return json({error:'Google sign-in required'},401);
      if(!adminAllowed(buyer,env))return json({error:'Owner canary only'},403);
      const guard=liveCheckoutOpen(env,buyer);
      if(!guard.ok)return json({error:'Real payment test not yet approved',reason:guard.reason,
        acceptingPayments:false,qrPayable:false},423);
      const doStub=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-v2-paid-ledger-v1'));
      const root=url.pathname==='/api/payments/v2/live/orders';
      if(root){
        if(request.method==='GET'){
          const result=await doStub.paidV2Recent({owner:buyer});
          return json(result,result.ok?200:409);
        }
        if(request.method!=='POST')return json({error:'Method not allowed'},405);
        if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))
          return json({error:'JSON required'},415);
        if(Number(request.headers.get('content-length')||0)>128)return json({error:'Body too large'},413);
        let parsed;
        try{const txt=await request.text();if(txt.length>128)throw Error('large');parsed=JSON.parse(txt)}
        catch{return json({error:'Invalid JSON'},400)}
        if(!parsed||Array.isArray(parsed)||Object.keys(parsed).length!==1||
           !['shield','win2','vip'].includes(parsed.sku))return json({error:'Unknown product'},400);
        let merchant;
        try{merchant=await preflightBeforeMoney(env)}catch(e){const diagnostic=e instanceof Slip2GoAdminError?e.publicDiagnostic():{reason:'internal',httpStatus:null,providerCode:null};return json({error:'Slip2Go merchant connection unavailable — do not transfer funds',diagnostic},503)}
        if(!merchant.ok)return json({error:'Merchant not ready — do not transfer funds',reason:merchant.reason},503);
        const result=await doStub.paidV2Create({owner:buyer,sku:parsed.sku,uuid:crypto.randomUUID()});
        return json(result,result.ok?(result.reused?200:201):409);
      }
      const matched=url.pathname.match(/^\/api\/payments\/v2\/live\/orders\/(payv2-[a-f0-9-]{36})(?:\/(qr|slip|reconcile))?$/);
      if(!matched)return json({error:'Not found'},404);
      const [,id,action]=matched;
      if(!action){
        if(request.method!=='GET')return json({error:'Method not allowed'},405);
        const result=await doStub.paidV2Get({owner:buyer,id});
        return json(result,result.ok?200:404);
      }
      if(action==='qr'){
        if(request.method!=='GET')return json({error:'Method not allowed'},405);
        const ready=await doStub.paidV2Qr({owner:buyer,id});
        if(!ready.ok)return json({error:ready.reason},409);
        let merchant;
        try{merchant=await preflightBeforeMoney(env)}catch(e){const diagnostic=e instanceof Slip2GoAdminError?e.publicDiagnostic():{reason:'internal',httpStatus:null,providerCode:null};return json({error:'Slip2Go merchant connection unavailable',diagnostic},503)}
        if(!merchant.ok)return json({error:'Merchant not ready',reason:merchant.reason},503);
        const q=qrcode(0,'M');q.addData(ready.payload);q.make();
        const svg=q.createSvgTag({cellSize:6,margin:24,scalable:true});
        return new Response(svg,{status:200,headers:{'Content-Type':'image/svg+xml; charset=utf-8',
         'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer',
         'X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin',
         'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"}});
      }
      if(action==='slip'){
        if(request.method!=='POST')return json({error:'Method not allowed'},405);
        let image;
        try{image=await readSlipImageRequest(request)}
        catch(err){return json({error:err instanceof SlipUploadError?err.code:"invalid_upload"},
          err instanceof SlipUploadError?err.status:400)}
        try{
          const result=await doStub.paidV2Verify({owner:buyer,id,bytes:image.bytes});
          return json(result,result.ok?200:result.verifiedButNotFulfilled?409:422);
        }finally{image.bytes.fill(0)}
      }
      if(action==='reconcile'){
        if(request.method!=='POST')return json({error:'Method not allowed'},405);
        const result=await doStub.paidV2Reconcile({owner:buyer,id});
        return json(result,result.ok?200:409);
      }
      return json({error:'Not found'},404);
    }
    // V2_GAME_BUYER_PREVIEW: Firebase-authenticated synthetic checkout only.
    if(url.pathname==='/api/payments/v2/demo-orders'||/^\/api\/payments\/v2\/demo-orders\/demo-v2-[a-f0-9-]{36}\/simulate$/.test(url.pathname)){
      if(request.method!=='GET'&&request.method!=='POST')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const buyer=await getAuthorizedUser(request,env);
      if(!buyer)return json({error:'Google sign-in required'},401);
      if(env.PAYMENTS_ENABLED!=='false'||env.PAYMENT_ROLLOUT!=='disabled')return json({error:'Demo mode unavailable'},409);
      const ledger=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-v2-game-preview-v1'));
      const creating=url.pathname==='/api/payments/v2/demo-orders';
      if(creating&&request.method==='GET'){
        const orders=await ledger.listBuyerPreviewV2({uid:buyer.id});
        return json({ok:true,simulation:true,orders,acceptingPayments:false,realBenefits:false},200);
      }
      if(request.method!=='POST')return json({error:'Method not allowed'},405);
      if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))return json({error:'JSON required'},415);
      if(Number(request.headers.get('content-length')||0)>128)return json({error:'Body too large'},413);
      let inputText;
      try{inputText=await request.text()}catch{return json({error:'Unreadable body'},400)}
      if(inputText.length>128)return json({error:'Body too large'},413);
      let body;
      try{body=JSON.parse(inputText)}catch{return json({error:'Invalid JSON'},400)}
      if(!body||Array.isArray(body)||Object.keys(body).length!==1)return json({error:'Invalid request'},400);
      if(creating){
        if(!['vip','shield','win2'].includes(body.sku))return json({error:'Invalid product'},400);
        const result=await ledger.createBuyerPreviewV2({uid:buyer.id,sku:body.sku,id:"demo-v2-"+crypto.randomUUID()});
        return json({...result,simulation:true,acceptingPayments:false},result.ok?(result.reused?200:201):429);
      }
      const id=url.pathname.split("/")[5];
      if(!['approved','unverified','wrong_amount','wrong_receiver','vip_full'].includes(body.scenario))return json({error:'Invalid scenario'},400);
      const result=await ledger.simulateBuyerPreviewV2({uid:buyer.id,id,scenario:body.scenario});
      return json({...result,simulation:true,acceptingPayments:false,providerCalled:false,realBenefits:false},result.ok?200:422);
    }
    // V2_SLIP_UPLOAD_PREFLIGHT: authenticated admin-only image ingest test, NO PROVIDER CALL.
    if(url.pathname==='/api/payments/v2/upload-preflight'){
      if(request.method!=='POST')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'Sign in required'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      if(env.PAYMENTS_ENABLED!=='false'||env.PAYMENT_ROLLOUT!=='disabled')return json({error:'Sandbox disabled'},409);
      let image;
      try{
        image=await readSlipImageRequest(request);
        const preview=publicSlipPreflightResult(image);
        image.bytes.fill(0);
        return json(preview,200);
      }catch(err){
        if(image?.bytes)image.bytes.fill(0);
        const recognized=err instanceof SlipUploadError;
        return json({ok:false,simulation:true,error:recognized?err.code:"upload_failed",
          providerCalled:false,orderCreated:false,entitlementGranted:false},
          recognized?err.status:400);
      }
    }
    // PAYMENT_V2_E2E_MOCK: isolated fake-provider + fake-VIP, no actual money.
    if(url.pathname==='/api/payments/v2/e2e-mock'){
      if(request.method!=='GET'&&request.method!=='POST')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'Sign in required'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      if(env.PAYMENTS_ENABLED!=='false'||env.PAYMENT_ROLLOUT!=='disabled')return json({error:'Mock is unavailable'},409);
      const mock=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-v2-e2e-mock-v1'));
      if(request.method==='GET')return json({ok:true,simulation:true,history:await mock.v2E2EMockHistory({uid:owner.id})},200);
      const result=await mock.runV2E2EMock({uid:owner.id,runId:"mock-run-"+crypto.randomUUID()});
      return json({ok:result.ok,simulation:true,result,acceptingPayments:false,providerCalled:false,realVipGranted:false},result.ok?200:422);
    }
    // PAYMENT_V2_ATOMIC_SMOKE: owner-only DB test, never verifies a real slip.
    if(url.pathname==='/api/payments/v2/atomic-smoke'){
      if(request.method!=='GET'&&request.method!=='POST')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'Sign in required'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      if(env.PAYMENTS_ENABLED!=='false'||env.PAYMENT_ROLLOUT!=='disabled')return json({error:'Test unavailable'},409);
      const mock=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-v2-atomic-sandbox-v1'));
      if(request.method==='GET')return json({ok:true,simulation:true,history:await mock.atomicSandboxHistory({uid:owner.id})},200);
      const result=await mock.atomicSandboxSmoke({uid:owner.id,runId:"mock-run-"+crypto.randomUUID()});
      return json({ok:result.ok,simulation:true,result,acceptingPayments:false,providerCalled:false,entitlementsModified:false},result.ok?200:422);
    }
    // PAYMENT_V2_MOCK_REPLAY_STORED: owner-only synthetic transfers, never real payment.
    if(url.pathname==='/api/payments/v2/mock-replay'){
      if(request.method!=='POST'&&request.method!=='GET')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'Sign in required'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      if(env.PAYMENTS_ENABLED!=='false'||env.PAYMENT_ROLLOUT!=='disabled')return json({error:'Sandbox disabled'},409);
      const mock=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-v2-sandbox-only'));
      if(request.method==='GET'){
        const history=await mock.listV2MockReplay({uid:owner.id});
        return json({ok:true,synthetic:true,history,acceptingPayments:false},200);
      }
      const result=await mock.runV2MockReplay({uid:owner.id,runId:"mock-run-"+crypto.randomUUID()});
      return json({ok:result.ok,synthetic:true,result,providerCalled:false,
        qrCreated:false,entitlementsModified:false,acceptingPayments:false},result.ok?200:429);
    }
    // PAYMENT_V2_SANDBOX_PERSISTENT: owner-only test records, no real payment.
    if(url.pathname==='/api/payments/v2/test-orders'){
      if(request.method!=='GET'&&request.method!=='POST')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'Sign in required'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      if(env.PAYMENTS_ENABLED!=='false'||env.PAYMENT_ROLLOUT!=='disabled')return json({error:'Sandbox unavailable while payments are active'},409);
      const sandbox=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-v2-sandbox-only'));
      const expose=o=>({id:o.id,sku:o.sku,amountBaht:o.amount,status:'test_only',
        createdAt:o.created_at,expiresAt:o.expires_at,expired:Date.now()>=o.expires_at,canPay:false,canFulfill:false});
      if(request.method==='GET'){
        const rows=await sandbox.listV2Sandbox({uid:owner.id});
        return json({ok:true,orders:rows.map(expose),simulation:true,acceptingPayments:false,qrCreated:false},200);
      }
      if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))return json({error:'JSON required'},415);
      if(Number(request.headers.get('content-length')||0)>128)return json({error:'Too large'},413);
      let sourceText;
      try{sourceText=await request.text()}catch{return json({error:'Invalid input'},400)}
      if(sourceText.length>128)return json({error:'Too large'},413);
      let body;
      try{body=JSON.parse(sourceText)}catch{return json({error:'Invalid JSON'},400)}
      if(!body||Array.isArray(body)||Object.keys(body).length!==1||!['shield','win2','vip'].includes(body.sku))return json({error:'Invalid test SKU'},400);
      const saved=await sandbox.createV2Sandbox({id:"test-v2-"+crypto.randomUUID(),uid:owner.id,sku:body.sku});
      if(!saved?.ok)return json({ok:false,error:saved?.reason||"sandbox_failed"},429);
      return json({ok:true,reused:saved.reused,order:expose(saved.order),simulation:true,acceptingPayments:false,
        qrCreated:false,slipVerified:false,entitlementsModified:false},saved.reused?200:201);
    }
    // PAYMENT_V2_CHECKOUT_DRY_RUN: local in-memory logic test; NOT a real order or slip.
    if(url.pathname==='/api/payments/v2/checkout-dry-run'){
      if(request.method!=='GET')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'Sign in required'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      if(env.PAYMENTS_ENABLED!=='false'||env.PAYMENT_ROLLOUT!=='disabled')
        return json({error:'Disable real payments before running dry-run'},409);
      const now=Date.now();
      const mockRecords=new Set();
      const skuList=['shield','win2','vip'];
      const orders=skuList.map(sku=>{
        const item=PRODUCTS[sku];
        if(!item||!Number.isSafeInteger(item.amount)||item.amount<=0)
          throw Error('Dry-run product configuration invalid');
        return {sku,amountBaht:item.amount,expiresAt:now+15*60_000,previewOnly:true};
      });
      const test=(order,opts={})=>{
        const amount=opts.amount??order.amountBaht;
        const receiver=opts.receiver??'02004';
        const status=opts.providerCode??'200200';
        const date=opts.checkedAt??now;
        const ref=opts.ref??'SYNTHETIC-REF-DRY-RUN-ONLY';
        if(status!=='200200')return {allowed:false,reason:'unverified'};
        if(receiver!=='02004')return {allowed:false,reason:'receiver_mismatch'};
        if(amount!==order.amountBaht)return {allowed:false,reason:'amount_mismatch'};
        if(date>order.expiresAt)return {allowed:false,reason:'expired'};
        if(mockRecords.has(ref))return {allowed:false,reason:'duplicate'};
        mockRecords.add(ref);
        return {allowed:true,reason:'mock_only'};
      };
      const sample=orders[0],valid=test(sample);
      const cases=[
        {name:'mock_valid',expected:'mock_only',result:valid.reason},
        {name:'duplicate_transfer',expected:'duplicate',result:test(sample).reason},
        {name:'wrong_amount',expected:'amount_mismatch',result:test(sample,{amount:sample.amountBaht+1,ref:'SYNTH-2'}).reason},
        {name:'wrong_receiver',expected:'receiver_mismatch',result:test(sample,{receiver:'02001',ref:'SYNTH-3'}).reason},
        {name:'unverified_slip',expected:'unverified',result:test(sample,{providerCode:'200000',ref:'SYNTH-4'}).reason},
        {name:'expired_order',expected:'expired',result:test(sample,{checkedAt:sample.expiresAt+1,ref:'SYNTH-5'}).reason}
      ];
      const passed=cases.every(c=>c.expected===c.result);
      return json({
        ok:passed,simulation:true,source:'server_authoritative_product_catalog',
        simulatedOrders:orders.map(x=>({sku:x.sku,amountBaht:x.amountBaht,expiresInMinutes:15,previewOnly:true})),
        ruleChecks:cases.map(x=>({name:x.name,passed:x.expected===x.result})),
        note:'Synthetic test data. No order, QR, slip validation, bank transfer, ledger entry or VIP entitlement created.',
        acceptingPayments:false,orderCreation:false,qrCreated:false,
        providerCalled:false,durableObjectCalled:false,entitlementsModified:false
      },200);
    }
    // PAYMENT_V2_FULL_WALLET_COMPARE: secure owner-only comparison, no persistent storage.
    // The owner copies their account from Slip2Go into this HTTPS POST, never through chat.
    // A match proves Worker configuration parity only, NOT legal ownership or bank settlement.
    if(url.pathname==='/api/payments/v2/receiver-confirm'){
      if(request.method!=='POST')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'Sign in required'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      if(env.MERCHANT_ACCOUNT_TYPE!=='02004'||typeof env.MERCHANT_ACCOUNT_NUMBER!=='string'||
        !/^\d{15}$/.test(env.MERCHANT_ACCOUNT_NUMBER))
        return json({ok:false,reason:'wallet_config_invalid',matched:false,acceptingPayments:false},503);
      if(!String(request.headers.get('content-type')||'').startsWith('application/json'))
        return json({ok:false,reason:'json_required'},415);
      const maxSize=Number(request.headers.get('content-length')||'0');
      if(maxSize>96)return json({ok:false,reason:'invalid_request'},413);
      let textBody;
      try{textBody=await request.text();}catch{return json({ok:false,reason:'invalid_request'},400)}
      if(textBody.length>96)return json({ok:false,reason:'invalid_request'},413);
      let input;
      try{input=JSON.parse(textBody);}catch{return json({ok:false,reason:'invalid_request'},400)}
      if(!input||typeof input.walletId!=='string'||!/^\d{15}$/.test(input.walletId))
        return json({ok:false,reason:'invalid_wallet_format',matched:false,acceptingPayments:false},400);
      const encoder=new TextEncoder();
      const [left,right]=await Promise.all([
        crypto.subtle.digest('SHA-256',encoder.encode(input.walletId)),
        crypto.subtle.digest('SHA-256',encoder.encode(env.MERCHANT_ACCOUNT_NUMBER))
      ]);
      let difference=0;
      const a=new Uint8Array(left),b=new Uint8Array(right);
      for(let i=0;i<a.length;i++)difference|=a[i]^b[i];
      const matched=difference===0;
      return json({ok:true,matched,receiverType:'02004',fullWalletMatch:matched,
        ownerVerified:false,bankSettlementVerified:false,
        acceptingPayments:false,orderCreation:false,qrCreated:false},200);
    }
    // PAYMENT_V2_RECEIVER_AUDIT_ONLY: review wallet/QR structure in memory only.
    // Never return a payable QR, raw payload, full wallet ID, or grant an entitlement.
    if(url.pathname==='/api/payments/v2/receiver-check'){
      if(request.method!=='GET')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'Sign in required'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      if(env.MERCHANT_ACCOUNT_TYPE!=='02004'||typeof env.MERCHANT_ACCOUNT_NUMBER!=='string'||
         !/^\d{15}$/.test(env.MERCHANT_ACCOUNT_NUMBER))
        return json({ok:false,reason:'wallet_type_or_format_mismatch',receiverType:'02004',verified:false,
           acceptingPayments:false,qrCreated:false},200);
      const wallet=env.MERCHANT_ACCOUNT_NUMBER;
      const parseTlv=(input)=>{
        const parts=new Map();let idx=0;
        while(idx<input.length){
          if(idx+4>input.length)throw Error('invalid_tlv_header');
          const tag=input.slice(idx,idx+2),n=input.slice(idx+2,idx+4);
          if(!/^\d{2}$/.test(tag)||!/^\d{2}$/.test(n))throw Error('invalid_tlv_length');
          const size=Number(n),end=idx+4+size;
          if(end>input.length||parts.has(tag))throw Error('invalid_tlv_field');
          parts.set(tag,input.slice(idx+4,end));idx=end;
        }
        return parts;
      };
      const auditAmount=amount=>{
        const payload=createPromptPayPayloadForReceiver('02004',wallet,amount);
        const outer=parseTlv(payload);
        const recipient=parseTlv(outer.get('29')||'');
        return outer.get('00')==='01'&&outer.get('01')==='12'&&
           outer.get('53')==='764'&&outer.get('58')==='TH'&&
           outer.get('54')===amount.toFixed(2)&&
           recipient.get('00')==='A000000677010111'&&
           recipient.get('03')===wallet&&recipient.size===2&&
           outer.get('63')===crc16CcittFalse(payload.slice(0,-4));
      };
      let checks=null;
      try{checks={tenBaht:auditAmount(10),hundredBaht:auditAmount(100)};}
      catch{checks={tenBaht:false,hundredBaht:false};}
      const qrStructureValid=checks.tenBaht===true&&checks.hundredBaht===true;
      return json({ok:qrStructureValid,receiverType:'e_wallet',accountType:'02004',
        maskedReceiver:'••••'+wallet.slice(-4),formatValid:true,qrStructureValid,checks,
        ownerVerified:false,acceptingPayments:false,qrCreated:false,
        reason:qrStructureValid?null:'qr_structure_mismatch'},200);
    }
    if(url.pathname==='/api/payments/v2/preflight'){
      if(request.method!=='GET')return json({error:'Method not allowed'},405);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const owner=await getAuthorizedUser(request,env);
      if(!owner)return json({error:'กรุณาเข้าสู่ระบบด้วย Google'},401);
      if(!adminAllowed(owner,env))return json({error:'Admin only'},403);
      if(typeof env.SLIP2GO_V2_SECRET!=='string'||!env.SLIP2GO_V2_SECRET)
        return json({ok:false,reason:'missing_v2_secret',acceptingPayments:false},503);
      // Validate credential copy/paste shape without disclosing any part of the key.
      // Only the authenticated and allowlisted Admin can view the diagnostic.
      const credential=env.SLIP2GO_V2_SECRET;
      const formatIssue=credential!==credential.trim()?'surrounding_whitespace'
        :/^(?:Bearer|Basic)\s/i.test(credential)?'unexpected_auth_scheme'
        :/^["']|["']$/.test(credential)?'extra_quotes'
        :/SLIP2GO_(?:V2_)?SECRET\s*=/.test(credential)?'pasted_binding_assignment'
        :/[\r\n\0-\x1f\x7f]/.test(credential)?'control_character'
        :null;
      if(formatIssue)return json({ok:false,providerAuthenticated:false,
        reason:formatIssue,acceptingPayments:false},503);
      try{
        // For this merchant key, a real read-only parity check confirmed Bearer -> 200001.
        // Only V2 account-info preflight uses this. Never enable a checkout based on this test alone.
        const account=await slip2goAccountInfo({...env,SLIP2GO_SECRET:'Bearer '+credential});
        const check=validateMerchantReadiness(account,env);
        return json({ok:check.ok,providerAuthenticated:true,shopName:account.shopName,
          package:account.package,tokenRemaining:account.tokenRemaining,
          estimatedQuotaSlip:account.estimatedQuotaSlip,
          receiverType:'e_wallet',receiverReady:env.MERCHANT_ACCOUNT_TYPE==='02004'&&/^\d{15}$/.test(env.MERCHANT_ACCOUNT_NUMBER||''),
          reason:check.ok?null:check.reason,acceptingPayments:false},200);
      }catch(e){
        const diagnostic=e instanceof Slip2GoAdminError?e.publicDiagnostic()
          :{reason:'internal',httpStatus:null,providerCode:null};
        return json({ok:false,providerAuthenticated:false,reason:'provider_rejected',diagnostic,
          acceptingPayments:false},502);
      }
    }
    if(url.pathname.startsWith('/api/payment')||url.pathname.startsWith('/api/orders')||url.pathname.startsWith('/api/admin/slip2go'))
      return json({ok:false,code:'PAYMENTS_REBUILD',error:'ระบบชำระเงินกำลังสร้างใหม่ ยังไม่สามารถสั่งซื้อหรือโอนเงินได้',acceptingPayments:false},503);
    if(url.pathname==='/api/health')return json({
      ok:true,mode:'staging',game:'snakes-and-ladders',
      authConfigured:Boolean(env.FIREBASE_PROJECT_ID&&env.FIREBASE_API_KEY),
      paymentsEnabled:paymentPublicEnabled(env),
      paymentReadiness:paymentReadiness(env)
    });
    if(url.pathname==='/api/online/counts'&&request.method==='GET'){
      try{
        const [free,vip]=await Promise.all(['free','vip'].map(server=>
          env.SCORES.get(env.SCORES.idFromName('scores-'+server+'-v1')).onlineCount(server)
        ));
        // Public aggregates only: never expose player email, UID, IP, or presence rows.
        return new Response(JSON.stringify({
          free:free.online,vip:vip.online,asOf:Date.now(),windowSeconds:90
        }),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }catch(e){
        console.error('online_counts',e);
        return json({error:'online_count_unavailable'},503);
      }
    }
    if(url.pathname==='/api/server/status'&&request.method==='GET'){
      const policy=await env.ITEMS.get(env.ITEMS.idFromName('inventory-v1')).securityStatus();
      return json({maintenance:{free:policy.free?.enabled===true,vip:policy.vip?.enabled===true}});
    }
    if(url.pathname==='/api/store/prices'&&request.method==='GET'){
      const paid=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-v2-paid-ledger-v1'));
      return json({prices:await paid.getPricesV2()});
    }
    if(url.pathname==='/api/config')return json({
      firebase:env.FIREBASE_PROJECT_ID&&env.FIREBASE_API_KEY&&env.FIREBASE_AUTH_DOMAIN&&env.FIREBASE_APP_ID?{
        apiKey:env.FIREBASE_API_KEY,authDomain:env.FIREBASE_AUTH_DOMAIN,projectId:env.FIREBASE_PROJECT_ID,appId:env.FIREBASE_APP_ID
      }:null,
      paymentsEnabled:paymentPublicEnabled(env)&&!V2_STAGE5_LOCKED,
      paymentV2Stage5Locked:V2_STAGE5_LOCKED,
      merchant:paymentPublicEnabled(env)?{name:env.MERCHANT_DISPLAY_NAME||null,method:'promptpay_qr',account:null}:null
    });
    // All mutations require a verified Firebase Google ID token and same-origin request.
    const protectedAPI=url.pathname.startsWith('/api/admin/')||url.pathname==='/api/me'||url.pathname==='/api/profile'||url.pathname==='/api/match'||url.pathname==='/api/player/presence'||url.pathname==='/api/payment/preflight'||url.pathname==='/api/orders'||url.pathname.startsWith('/api/orders/');
    let user=null;
    if(protectedAPI){
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      user=await getAuthorizedUser(request,env);
      if(!user)return json({error:'กรุณาเข้าสู่ระบบด้วย Google'},401);
    }
    // Owner-only, read-only merchant connectivity check. Does not create QR, charge, or verify slips.
    // Works even while PAYMENTS_ENABLED=false and never returns the provider credential.
    if(url.pathname==='/api/payment/preflight'){
      if(request.method!=='GET')return json({error:'Method not allowed'},405);
      if(!adminAllowed(user,env))return json({error:'ไม่มีสิทธิ์ตรวจสอบการเชื่อมต่อ Slip2Go'},403);
      try{
        const account=await slip2goAccountInfo(env);
        return json({ok:true,shopName:account.shopName,package:account.package,
          tokenRemaining:account.tokenRemaining,quotaQrRemaining:account.quotaQrRemaining,
          paymentsEnabled:paymentConfigured(env)});
      }catch(e){
        const diagnostic=e instanceof Slip2GoAdminError?e.publicDiagnostic():{reason:'internal',httpStatus:null,providerCode:null};
        return json({ok:false,error:'ตรวจสอบการเชื่อมต่อ Slip2Go ไม่สำเร็จ',diagnostic},502);
      }
    }
    if(url.pathname.startsWith('/api/admin/')){
      // All admin endpoints require an authenticated, email-verified Google account.
      // An allowlisted identity is checked on the server, not trusted from the browser.
      if(!adminAllowed(user,env))return json({error:'ไม่มีสิทธิ์ใช้งาน Admin'},403);
      if(url.pathname==='/api/admin/payments/vip'){
        if(request.method!=='GET')return json({error:'Method not allowed'},405);
        const paid=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-v2-paid-ledger-v1'));
        return json(await paid.adminVipOrderHistory({
          limit:Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||50)),
          offset:Math.max(0,Number(url.searchParams.get('offset'))||0)
        }));
      }
      if(url.pathname.startsWith('/api/admin/control/')){
        const action=url.pathname.slice('/api/admin/control/'.length);
        const items=env.ITEMS.get(env.ITEMS.idFromName('inventory-v1'));
        if(action==='status'&&request.method==='GET'){
          const state=await items.securityStatus();
          return json({ok:true,maintenance:{free:state.free,vip:state.vip},bannedTotal:state.bannedTotal});
        }
        if(action==='bans'&&request.method==='GET')return json(await items.securityBans({
          limit:Number(url.searchParams.get('limit'))||50,offset:Number(url.searchParams.get('offset'))||0
        }));
        if(action==='audit'&&request.method==='GET')return json(await items.securityAudit({limit:50}));
        if(!['ban','maintenance'].includes(action))return json({error:'Not found'},404);
        if(request.method!=='POST')return json({error:'Method not allowed'},405);
        if(Number(request.headers.get('Content-Length')||0)>600)return json({error:'Request too large'},413);
        let data;
        try{const rawBody=await request.text();if(rawBody.length>600)throw Error('too_large');data=JSON.parse(rawBody)}
        catch{return json({error:'Invalid JSON'},400)}
        if(!data||Array.isArray(data)||typeof data!=='object')return json({error:'Invalid input'},400);
        if(action==='ban'){
          if(data.uid===user.id)return json({error:'Cannot ban the administrator account'},403);
          const result=await items.securityBan({uid:data.uid,banned:data.banned,reason:data.reason||'',actor:user.email});
          return json(result,result.ok?200:400);
        }
        const result=await items.securityMaintenance({server:data.server,enabled:data.enabled,note:data.note||'',actor:user.email});
        return json(result,result.ok?200:400);
      }
      if(url.pathname==='/api/admin/store/prices'){
        const payments=env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-v2-paid-ledger-v1'));
        if(request.method==='GET')return json({prices:await payments.getPricesV2(),audit:await payments.priceAuditsV2()});
        if(request.method!=='POST')return json({error:'Method not allowed'},405);
        if(Number(request.headers.get('Content-Length')||0)>350)return json({error:'Request too large'},413);
        let body;try{const data=await request.text();if(data.length>350)throw Error('too_long');body=JSON.parse(data)}catch{return json({error:'Invalid JSON'},400)}
        const changed=await payments.setPricesV2({prices:body?.prices,actor:user.email});
        return json(changed,changed.ok?200:400);
      }
      if(url.pathname.startsWith('/api/admin/board/')){
        const action=url.pathname.slice('/api/admin/board/'.length);
        const modifying=action==='edit'||action==='reset';
        if(modifying&&request.method!=='POST')return json({error:'Method not allowed'},405);
        if(!modifying&&request.method!=='GET')return json({error:'Method not allowed'},405);
        let data={};
        if(modifying){
          if(Number(request.headers.get('Content-Length')||0)>1400)return json({error:'Request too large'},413);
          try{const txt=await request.text();if(txt.length>1400)throw Error('length');data=JSON.parse(txt)}
          catch{return json({error:'Invalid JSON'},400)}
        }
        const server=modifying?data?.server:url.searchParams.get('server');
        if(server!=='free'&&server!=='vip')return json({error:'Invalid server'},400);
        const stub=env.SCORES.get(env.SCORES.idFromName('scores-'+server+'-v1'));
        if(action==='players'){
          const onlineOnly=url.searchParams.get('online')==='1',limit=Number(url.searchParams.get('limit'))||150,offset=Number(url.searchParams.get('offset'))||0;
          const roster=await stub.adminPlayers({server,onlineOnly,limit,offset});
          const flags=await env.ITEMS.get(env.ITEMS.idFromName('inventory-v1')).bansForUids({uids:roster.players.map(p=>p.uid)});
          return json({...roster,players:roster.players.map(p=>({...p,banned:flags[p.uid]===true}))});
        }
        if(action==='export'){
          return json(await stub.adminExport({server,
            limit:Math.min(500,Math.max(1,Number(url.searchParams.get('limit'))||250)),
            offset:Math.max(0,Number(url.searchParams.get('offset'))||0),actor:user.email
          }));
        }
        if(action==='history')return json(await stub.adminHistory({server}));
        if(action==='audit')return json(await stub.adminAudit({server}));
        if(action==='edit'){
          const uid=data?.uid,name=data?.name,score=data?.score;
          if(!validId(uid)||(name===undefined&&score===undefined))return json({error:'Invalid edit'},400);
          const outcome=await stub.adminEdit({server,uid,name,score,actor:user.email});
          if(!outcome.ok)return json({error:outcome.reason},400);
          if(name!==undefined){
            const changed=await env.ITEMS.get(env.ITEMS.idFromName('inventory-v1')).setProfile({uid,name});
            if(!changed.ok)return json({error:'Score updated but profile sync failed',reason:changed.reason},503);
            await Promise.allSettled(['free','vip'].map(s=>env.SCORES.get(env.SCORES.idFromName('scores-'+s+'-v1')).rename({id:uid,name,server:s})));
          }
          return json(outcome);
        }
        if(action==='reset'){
          if(data?.confirm!=='RESET')return json({error:'Confirmation required'},400);
          return json(await stub.adminReset({server,actor:user.email}));
        }
        return json({error:'Not found'},404);
      }
      if(request.method!=='GET')return json({error:'Method not allowed'},405);
      if(url.pathname==='/api/admin/session')return json({admin:true});
      try{
        if(url.pathname==='/api/admin/slip2go/account'){
          const info=await slip2goAccountInfo(env);
          return json({ok:true,account:info});
        }
        if(url.pathname==='/api/admin/slip2go/history'){
          const id=url.searchParams.get('referenceId');
          if(!validSlipReference(id))return json({error:'ต้องใช้ Slip2Go referenceId ที่ถูกต้อง'},400);
          const slip=await slip2goSlipHistory(env,id);
          return json({ok:true,slip});
        }
      }catch(e){
        // Only bounded, enumerated diagnostic metadata is returned to the verified Admin.
        // No raw provider message, Authorization header, bank account, or slip payload.
        if(e instanceof Slip2GoAdminError){
          const diagnostic=e.publicDiagnostic();
          console.warn('admin Slip2Go lookup failed',diagnostic.reason,diagnostic.httpStatus,diagnostic.providerCode);
          return json({error:'ดึงข้อมูล Slip2Go ไม่สำเร็จ',diagnostic},502);
        }
        console.warn('admin Slip2Go lookup failed unexpectedly');
        return json({error:'ดึงข้อมูล Slip2Go ไม่สำเร็จ',diagnostic:{reason:'internal',httpStatus:null,providerCode:null}},502);
      }
      return json({error:'Not found'},404);
    }
    const vip=()=>env.VIP.get(env.VIP.idFromName('vip-memberships-v1'));
    const items=()=>env.ITEMS.get(env.ITEMS.idFromName('inventory-v1'));
    const ledger=()=>env.PAYMENTS.get(env.PAYMENTS.idFromName('payment-ledger-v1'));
    if(url.pathname==='/api/me'&&request.method==='GET')return json({
      id:user.id,email:user.email,
      vip:await vip().hasAccess(user.id),
      items:await items().getItems(user.id),
      nickname:(await items().getProfile(user.id)).name,
      canPurchase:liveCheckoutOpen(env,user).ok,
      paymentCanaryOnly:env.PAYMENT_ROLLOUT==='canary'&&adminAllowed(user,env),
      canPaymentPreflight:adminAllowed(user,env)
    });
    if(url.pathname==='/api/profile'&&request.method==='POST'){
      if(Number(request.headers.get('Content-Length')||0)>1000)return json({error:'ข้อมูลชื่อใหญ่เกินไป'},413);
      let body;try{body=await request.json();}catch{return json({error:'รูปแบบข้อมูลไม่ถูกต้อง'},400);}
      const result=await items().setProfile({uid:user.id,name:body?.name});
      if(!result.ok)return json({error:'ชื่อผู้เล่นต้องมี 1–18 ตัวอักษร และไม่มีสัญลักษณ์ต้องห้าม'},400);
      // Update old leaderboard labels without modifying earned points.
      await Promise.allSettled(['free','vip'].map(server=>
        env.SCORES.get(env.SCORES.idFromName(`scores-${server}-v1`))
          .rename({id:user.id,name:result.profile.name,server})
      ));
      return json({ok:true,nickname:result.profile.name});
    }
    if(url.pathname==='/api/orders/recent'&&request.method==='GET'){
      const recent=await ledger().getRecent(user.id);
      return json({order:recent?publicOrder(recent):null});
    }
    if(url.pathname==='/api/orders'&&request.method==='POST'){
      if(!paymentConfigured(env))return json({error:'ยังไม่เปิดรับชำระเงินจริง'},503);
        if(!paymentRolloutAllowed(env,user))return json({error:'เปิดทดสอบชำระเงินเฉพาะบัญชีเจ้าของเกม'},403);
      let body;try{body=await request.json();}catch{return json({error:'Bad JSON'},400);}
      if(!PRODUCTS[body?.sku])return json({error:'ไม่มีสินค้านี้'},400);
      if(!allowedCanaryItem(env,body.sku))
        return json({error:'ทดสอบเงินจริงครั้งแรกได้เฉพาะไอเทมเกราะกันงู 10 บาท'},403);
      if(env.PAYMENT_ROLLOUT==='canary'&&await ledger().hasPreviousPaid(user.id))
        return json({error:'บัญชีทดสอบชำระสำเร็จแล้วหนึ่งรายการ กรุณาตรวจสิทธิ์ก่อนทดสอบซ้ำ'},409);
      // Never display a live receiving QR when Slip2Go cannot authenticate the merchant,
      // the linked shop is wrong, its package has expired, or its balance is empty.
      try{
        const check=await preflightBeforeMoney(env);
        if(!check.ok)return json({error:'ยังไม่พร้อมรับเงินจริง: '+check.reason,preflightReason:check.reason},503);
      }catch(e){
        const diagnostic=e instanceof Slip2GoAdminError?e.publicDiagnostic()
          :{reason:'internal',httpStatus:null,providerCode:null};
        return json({error:'ยังไม่สามารถตรวจความพร้อม Slip2Go จึงไม่สร้าง QR รับเงิน',diagnostic},503);
      }
      const id=`order-${crypto.randomUUID()}`;
      const created=await ledger().create({id,uid:user.id,sku:body.sku});
      if(!created.ok)return json({error:created.reason},429);
      const order=created.order;
      if(order.sku==='vip'){
        const reserved=await vip().reserveForCheckout({userId:user.id,orderId:order.id});
        if(!reserved.ok){
          await ledger().cancelPending({id:order.id,uid:user.id});
          return json({error:reserved.reason},409);
        }
      }
      return json({order:publicOrder(order)},201);
    }
    const orderMatch=url.pathname.match(/^\/api\/orders\/(order-[a-f0-9-]{36})(?:\/(verify|reconcile|qr))?$/);
    if(orderMatch){
      const [,id,action]=orderMatch;
      const current=await ledger().get(id,user.id);
      if(!current)return json({error:'ไม่พบคำสั่งซื้อ'},404);
      if(!action&&request.method==='GET')return json({order:publicOrder(current)});
      // A QR is issued only for the authenticated owner's unexpired pending order.
      // The full PromptPay number must never be serialized into public JSON or HTML.
      if(action==='qr'&&request.method==='GET'){
        if(!paymentConfigured(env))return json({error:'ยังไม่เปิดรับชำระเงินจริง'},503);
        if(!paymentRolloutAllowed(env,user))return json({error:'เปิดทดสอบชำระเงินเฉพาะบัญชีเจ้าของเกม'},403);
        if(!allowedCanaryItem(env,current.sku))return json({error:'Canary item not allowed'},403);
        if(current.status!=='pending'||Date.now()>current.expires_at)return json({error:'คำสั่งซื้อไม่อยู่ในสถานะชำระเงินได้'},409);
        try{
          const payload=createPromptPayPayloadForReceiver(env.MERCHANT_ACCOUNT_TYPE,env.MERCHANT_ACCOUNT_NUMBER,current.amount);
          const qr=qrcode(0,'M');
          qr.addData(payload);qr.make();
          const svg=qr.createSvgTag({cellSize:6,margin:24,scalable:true});
          return new Response(svg,{status:200,headers:{
            'Content-Type':'image/svg+xml; charset=utf-8',
            'Cache-Control':'private, no-store',
            'Referrer-Policy':'no-referrer',
            'X-Content-Type-Options':'nosniff',
            'Cross-Origin-Resource-Policy':'same-origin',
            'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"
          }});
        }catch(e){
          console.warn('PromptPay QR generation error',String(e?.name||'failure'));
          return json({error:'สร้าง QR ชำระเงินไม่สำเร็จ'},503);
        }
      }
      if(action==='reconcile'&&request.method==='POST'){
        return await fulfillOrder(current,user,env);
      }
      if(action==='verify'&&request.method==='POST'){
        if(!paymentConfigured(env))return json({error:'ยังไม่เปิดรับชำระเงินจริง'},503);
        if(!paymentRolloutAllowed(env,user))return json({error:'เปิดทดสอบชำระเงินเฉพาะบัญชีเจ้าของเกม'},403);
        if(!allowedCanaryItem(env,current.sku))return json({error:'Canary item not allowed'},403);
        if(Number(request.headers.get('Content-Length')||0)>4_300_000)return json({error:'ไฟล์ใหญ่เกินไป'},413);
        const lock=await ledger().takeVerification({id,uid:user.id});
        if(!lock.ok)return json({error:lock.reason},409);
        if(lock.alreadyPaid)return await fulfillOrder(lock.order,user,env);
        try{
          const form=await request.formData();
          const verification=await verifySlip(form.get('slip'),{
            amount:current.amount,createdAt:current.created_at,expiresAt:current.expires_at
          },env);
          const hash=await transferFingerprint(verification);
          const confirmed=await ledger().recordVerified({id,uid:user.id,hash});
          if(!confirmed.ok)return json({error:confirmed.reason},409);
          return await fulfillOrder(await ledger().get(id,user.id),user,env);
        }catch(e){
          console.warn('slip verification failed',String(e?.message||'error').slice(0,80));
          return json({error:String(e?.message||'ตรวจสลิปไม่สำเร็จ')},422);
        }finally{await ledger().unlock({id,uid:user.id});}
      }
    }
    if(url.pathname==='/api/player/presence'&&request.method==='POST'){
      if(Number(request.headers.get('Content-Length')||0)>250)return json({error:'Request too large'},413);
      let body;try{body=await request.json()}catch{return json({error:'Invalid JSON'},400)}
      const server=body?.server;
      if(server!=='free'&&server!=='vip')return json({error:'Invalid server'},400);
      const policy=await env.ITEMS.get(env.ITEMS.idFromName('inventory-v1')).gameAccess({uid:user.id,server,ignoreMaintenance:true});
      if(!policy.allowed)return json({error:'บัญชีถูกระงับ',code:policy.code},403);
      if(server==='vip'&&!await env.VIP.get(env.VIP.idFromName('vip-memberships-v1')).hasAccess(user.id))return json({error:'VIP required'},403);
      const profile=await env.ITEMS.get(env.ITEMS.idFromName('inventory-v1')).getProfile(user.id);
      if(!profile?.name)return json({error:'Nickname required'},409);
      const avatar=Number.isInteger(body?.avatar)&&body.avatar>=0&&body.avatar<AVATARS.length?body.avatar:0;
      const saved=await env.SCORES.get(env.SCORES.idFromName('scores-'+server+'-v1')).heartbeat({id:user.id,email:user.email,name:profile.name,avatar,server});
      return json(saved,saved.ok?200:400);
    }
    if(url.pathname==='/api/match'&&request.method==='POST'){
      let body;try{body=await request.json();}catch{return json({error:'รูปแบบข้อมูลไม่ถูกต้อง'},400);}
      const server=body?.server==='vip'?'vip':body?.server==='free'?'free':null;
      if(!server)return json({error:'เลือกเซิร์ฟเวอร์ให้ถูกต้อง'},400);
      const policy=await items().gameAccess({uid:user.id,server});
      if(!policy.allowed)return json({error:policy.code==='maintenance'?'เซิร์ฟเวอร์อยู่ระหว่างปรับปรุง':policy.code==='banned'?'บัญชีถูกระงับ':'เข้าเซิร์ฟเวอร์ไม่ได้',code:policy.code},policy.code==='maintenance'?423:403);
      if(server==='vip'&&!await vip().hasAccess(user.id))return json({error:'ต้องมีสมาชิก VIP ที่ยังไม่หมดอายุ'},403);
      const inventory=await items().getItems(user.id);
      const savedName=(await items().getProfile(user.id)).name;
      if(!savedName)return json({error:'กรุณาบันทึกชื่อผู้เล่นก่อนจับคู่'},409);
      const profile={id:user.id,name:savedName,avatar:Number.isInteger(body.avatar)&&body.avatar>=0&&body.avatar<AVATARS.length?body.avatar:0,
        server,shield:inventory.shield>Date.now()?1:0,rewardX2:inventory.win2>Date.now()};
      try{
        const lobby=env.LOBBY.get(env.LOBBY.idFromName(`lobby-${server}-v1`));
        return json(await lobby.assign(profile));
      }catch(e){console.error('match',e);return json({error:'ขัดข้องชั่วคราว กรุณาลองใหม่'},503);}
    }
    if(url.pathname==='/api/vip/capacity' && request.method==='GET'){
      try{return json(await env.VIP.get(env.VIP.idFromName('vip-memberships-v1')).getStatus());}
      catch(e){console.error('vip capacity',e);return json({error:'VIP capacity unavailable'},503);}
    }
    if(url.pathname==='/api/leaderboard'){
      try{const board=url.searchParams.get('server')==='vip'?'vip':'free';
        return json({leaders:await env.SCORES.get(env.SCORES.idFromName(`scores-${board}-v1`)).getLeaders(board)});}
      catch(e){console.error('leaders',e);return json({leaders:[]},503);}
    }
    if(url.pathname==='/ws'){
      const room=url.searchParams.get('room');
      if(!validRoom(room))return json({error:'ห้องไม่ถูกต้อง'},400);
      if(!requireSameOrigin(request))return json({error:'Origin not allowed'},403);
      const stub=env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }
    if(request.method==='GET'||request.method==='HEAD')return serveStatic(request);
    return json({error:'Not found'},404);
  }
};

// One lobby per server. Duplicate matchmaking retries rejoin the existing room,
// instead of reserving multiple seats for one Google UID.
export class Lobby extends DurableObject {
  async assign(profile){
    return this.ctx.blockConcurrencyWhile(async()=>{
      const now=Date.now();
      const key=`member:${profile.id}`;
      const previous=this.ctx.storage.kv.get(key);
      if(previous&&now-previous.at<60*60_000){
        const stub=this.env.ROOM.get(this.env.ROOM.idFromName(previous.roomId));
        const renewed=await stub.reissueTicket({userId:profile.id});
        if(renewed.ok)return {room:previous.roomId,ticket:renewed.ticket,playerId:profile.id,seat:renewed.seat,rejoined:true};
      }
      let waiting=this.ctx.storage.kv.get('waiting');
      if(!waiting||waiting.count>=3||now-waiting.created>90_000){
        waiting={roomId:`room-${crypto.randomUUID()}`,count:0,created:now};
      }
      const ticket=crypto.randomUUID();
      const room=this.env.ROOM.get(this.env.ROOM.idFromName(waiting.roomId));
      let accepted=await room.reserve({profile,ticket,roomId:waiting.roomId});
      if(!accepted.ok){
        waiting={roomId:`room-${crypto.randomUUID()}`,count:0,created:now};
        accepted=await this.env.ROOM.get(this.env.ROOM.idFromName(waiting.roomId)).reserve({profile,ticket,roomId:waiting.roomId});
        if(!accepted.ok)throw Error('Room reservation failed');
      }
      waiting.count++;
      this.ctx.storage.kv.put('waiting',waiting);
      this.ctx.storage.kv.put(key,{roomId:waiting.roomId,at:now});
      return {room:waiting.roomId,ticket,playerId:profile.id,seat:waiting.count};
    });
  }
}

export class GameRoom extends DurableObject {
  load(){return this.ctx.storage.kv.get('game');}
  save(game){this.ctx.storage.kv.put('game',game);}
  async reserve({profile,ticket,roomId}){
    let game=this.load()||createGame(roomId);
    const now=Date.now();
    if(game.players.length===0){game.server=profile.server;game.waitExpiresAt=now+120_000;}
    if(game.status!=='waiting'||now>=(game.waitExpiresAt||0)||game.players.length>=3||game.players.some(p=>p.id===profile.id)||game.server!==profile.server)return {ok:false};
    const access=await this.env.ITEMS.get(this.env.ITEMS.idFromName('inventory-v1')).gameAccess({uid:profile.id,server:profile.server});
    if(!access.allowed)return {ok:false,reason:access.code};
    game.players.push({id:profile.id,name:profile.name,avatar:profile.avatar,pos:0,shield:profile.shield||0,rewardX2:profile.rewardX2===true,stars:0,ticket,issuedAt:now});
    this.save(game);
    if(game.players.length===1)await this.ctx.storage.setAlarm(game.waitExpiresAt);
    return {ok:true};
  }
  // Rejoin is allowed only for a UID already reserved in this specific room.
  // Refreshing the short-lived bearer ticket revokes the previous ticket.
  async reissueTicket({userId}){
    let game=this.load();
    // Catch up skipped turns even if this room had no connected sockets.
    if(game?.status==='playing'&&Date.now()>=game.turnEndsAt){
      await this.timeout(game);
      game=this.load();
    }
    if(!game||!['waiting','playing'].includes(game.status)||
       (game.status==='waiting'&&Date.now()>=(game.waitExpiresAt||0)))return {ok:false};
    const seat=game.players.findIndex(p=>p.id===userId);
    if(seat<0)return {ok:false};
    const ticket=crypto.randomUUID();
    game.players[seat].ticket=ticket;
    game.players[seat].issuedAt=Date.now();
    this.save(game);
    return {ok:true,ticket,seat:seat+1};
  }
  activeIds(){
    return [...new Set(this.ctx.getWebSockets().map(ws=>ws.deserializeAttachment()?.pid).filter(Boolean))];
  }
  safeState(game){
    // Never include reservation tickets in a broadcast.
    const {players,...rest}=game;
    return {...rest,players:players.map(({ticket,issuedAt,...p})=>p)};
  }
  broadcast(game){
    const message=JSON.stringify({type:'state',state:this.safeState(game),connected:this.activeIds(),serverTime:Date.now()});
    for(const ws of this.ctx.getWebSockets())try{ws.send(message);}catch{}
  }
  // Three consecutive turns without a valid roll (about 60 seconds).
  maxNoRollTurns(){return 3;}
  async scheduleTurnAlarm(game,retryPrize=false){
    if(game.status!=='playing')return;
    const remaining=Math.max(1,this.maxNoRollTurns()-(game.noRollTurns||0));
    // When everyone disconnects, hibernate until the final no-roll deadline.
    // The exact skipped turns are settled when a player reconnects or the alarm fires.
    const wake=this.activeIds().length?game.turnEndsAt:
      game.turnEndsAt+(remaining-1)*TURN_MS;
    await this.ctx.storage.setAlarm(retryPrize?Math.min(wake,Date.now()+15_000):wake);
  }
  async closeForNoRolls(game){
    game.status='abandoned';
    game.closeReason='no_rolls_3_turns';
    game.closedAt=Date.now();
    game.lastRoll=0;game.lastMove=0;
    game.log=['🚪 ปิดห้องอัตโนมัติ: ไม่มีผู้เล่นทอยลูกเต๋าติดต่อกันครบ 3 เทิร์น',...game.log].slice(0,5);
    this.save(game);this.broadcast(game);
    for(const ws of this.ctx.getWebSockets()){
      try{ws.close(4003,'Room closed: no rolls for 3 turns');}catch{}
    }
    // Keep retrying an earned Lucky Box award if the scoreboard was temporarily unavailable.
    if(game.boxUsed&&!game.prizeCredited)await this.ctx.storage.setAlarm(Date.now()+15_000);
  }
  async fetch(request){
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket required'},426);
    const ticket=new URL(request.url).searchParams.get('ticket');
    let game=this.load();
    if(game?.status==='playing'&&Date.now()>=game.turnEndsAt){
      await this.timeout(game);
      game=this.load();
    }
    const player=game?.players.find(p=>p.ticket===ticket&&Date.now()-p.issuedAt<120_000);
    if(!player||!ticket||game.status==='abandoned')return json({error:'ไม่มีสิทธิ์เข้าห้อง'},403);
    const access=await this.env.ITEMS.get(this.env.ITEMS.idFromName('inventory-v1')).gameAccess({uid:player.id,server:game.server,ignoreMaintenance:true});
    if(!access.allowed)return json({error:'บัญชีถูกระงับ',code:access.code},403);
    for(const ws of this.ctx.getWebSockets()){
      if(ws.deserializeAttachment()?.pid===player.id){try{ws.close(4001,'Reconnected');}catch{}}
    }
    const pair=new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({pid:player.id});
    if(game.status==='playing'){
      // Reconnecting cannot reset the no-roll counter or extend the current turn.
      await this.scheduleTurnAlarm(game);
    }
    if(game.status==='waiting'&&game.players.length===3&&this.activeIds().length===3){
      game.status='playing';game.current=0;game.noRollTurns=0;game.turnEndsAt=Date.now()+TURN_MS;
      game.log=['เริ่มเกม! ผู้เล่นแต่ละคนมีเวลา 20 วินาที',...game.log].slice(0,5);
      this.save(game);
      await this.ctx.storage.setAlarm(game.turnEndsAt);
    }
    this.broadcast(game);
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  async webSocketMessage(ws,message){
    if(typeof message!=='string'||message.length>256)return;
    let msg;try{msg=JSON.parse(message);}catch{return;}
    if(msg?.type!=='roll')return;
    const game=this.load();if(!game||game.status!=='playing')return;
    // Never accept a late roll. Settle every timed-out turn first.
    if(Date.now()>=game.turnEndsAt){await this.timeout(game);return;}
    const pid=ws.deserializeAttachment()?.pid;
    if(!pid)return;
    // Check moderation on a roll: a banned account cannot continue playing.
    const access=await this.env.ITEMS.get(this.env.ITEMS.idFromName('inventory-v1')).gameAccess({uid:pid,server:game.server,ignoreMaintenance:true});
    if(!access.allowed){try{ws.close(4003,'Access revoked');}catch{}return;}
    if(Date.now()>=game.turnEndsAt){await this.timeout(game);return;}
    if(game.players[game.current]?.id!==pid)return;
    const dice=randomInt(6)+1;
    game.noRollTurns=0;
    executeRoll(game,game.current,dice);
    if(game.status==='playing')advance(game);
    this.save(game);
    this.broadcast(game);
    // Both rewards are idempotent on the Scores Durable Object using room-scoped keys.
    const prizeRetry=await this.creditPrize(game);
    if(game.status==='finished')await this.creditWinner(this.load());
    const latest=this.load();
    if(latest.status==='playing')await this.scheduleTurnAlarm(latest,prizeRetry);
    else if(prizeRetry)await this.ctx.storage.setAlarm(Date.now()+15_000);
  }
  async timeout(game){
    if(game.status!=='playing'||Date.now()<game.turnEndsAt)return;
    const now=Date.now();
    // Fast-forward missed turns based on their original deadlines (not "now").
    // This is also safe for rooms with zero open WebSockets.
    let expired=0;
    while(game.status==='playing'&&now>=game.turnEndsAt&&expired<this.maxNoRollTurns()){
      const name=game.players[game.current]?.name||'ผู้เล่น';
      game.noRollTurns=(game.noRollTurns||0)+1;
      expired++;
      if(game.noRollTurns>=this.maxNoRollTurns()){
        await this.closeForNoRolls(game);
        break;
      }
      game.log=[`⌛ ${name} หมดเวลา — ข้ามตาโดยไม่ทอย (${game.noRollTurns}/3)`,...game.log].slice(0,5);
      game.lastRoll=0;game.lastMove=0;
      game.current=(game.current+1)%3;
      game.turnEndsAt+=TURN_MS;
    }
    if(game.status==='playing'){
      this.save(game);this.broadcast(game);
      await this.scheduleTurnAlarm(game,game.boxUsed&&!game.prizeCredited);
    }
  }
  async creditPrize(game){
    if(!game?.boxUsed||game.prizeCredited||!game.boxWinnerId||!game.boxReward)return false;
    const awarded=game.players.find(p=>p.id===game.boxWinnerId);
    if(!awarded)return false;
    try{
      // A false response also means the same one-time award was already processed.
      await this.env.SCORES.get(this.env.SCORES.idFromName(`scores-${game.server||'free'}-v1`)).creditPrize({
        id:awarded.id,name:awarded.name,avatar:awarded.avatar,gameId:game.roomId,points:game.boxReward,server:game.server||'free'
      });
      const latest=this.load();
      if(latest?.roomId===game.roomId&&!latest.prizeCredited){latest.prizeCredited=true;this.save(latest);}
      return false;
    }catch(e){console.error('lucky box credit',e);return true;}
  }
  async creditWinner(game){
    if(!game.winnerId||game.credited)return;
    const winner=game.players.find(p=>p.id===game.winnerId);
    if(!winner)return;
    try{
      await this.env.SCORES.get(this.env.SCORES.idFromName(`scores-${game.server||'free'}-v1`)).credit({id:winner.id,name:winner.name,avatar:winner.avatar,gameId:game.roomId,points:game.winPoints||10,server:game.server||'free'});
      game.credited=true;this.save(game);
    }catch(e){console.error('credit',e);await this.ctx.storage.setAlarm(Date.now()+15_000);}
  }
  async alarm(){
    let game=this.load();if(!game)return;
    if(game.status==='waiting'){
      if(Date.now()>=(game.waitExpiresAt||0)){
        game.status='abandoned';
        game.closeReason='waiting_expired';
        game.log=['ห้องรอผู้เล่นไม่ครบภายในเวลาที่กำหนด กรุณาจับคู่ใหม่',...game.log].slice(0,5);
        this.save(game);this.broadcast(game);
        for(const ws of this.ctx.getWebSockets())try{ws.close(4003,'Waiting room expired');}catch{}
      }else await this.ctx.storage.setAlarm(game.waitExpiresAt);
      return;
    }
    const prizeRetry=await this.creditPrize(game);
    game=this.load();
    if(game.status==='playing'){
      if(Date.now()>=game.turnEndsAt)await this.timeout(game);
      else await this.scheduleTurnAlarm(game,prizeRetry);
    }else if(game.status==='finished'){
      if(!game.credited)await this.creditWinner(game);
      if(prizeRetry)await this.ctx.storage.setAlarm(Date.now()+15_000);
    }else if(game.status==='abandoned'&&prizeRetry){
      await this.ctx.storage.setAlarm(Date.now()+15_000);
    }
  }
  async webSocketClose(ws){
    const game=this.load();
    if(game?.status==='playing'&&this.activeIds().length===0){
      // Single wake-up at the 3-round no-roll deadline, not an endless 20s loop.
      await this.scheduleTurnAlarm(game,game.boxUsed&&!game.prizeCredited);
    }
    if(game)this.broadcast(game);
  }
  async webSocketError(ws){
    const game=this.load();if(game)this.broadcast(game);
  }
}

export class Scores extends DurableObject {
  board(){return this._adminBoard||(this._adminBoard=new AdminBoard(this.ctx.storage));}
  async ensureBoard(server){
    if(server!=='free'&&server!=='vip')throw Error('invalid_score_server');
    const kv=this.ctx.storage.kv;
    const existing=kv.get('admin:server');
    if(existing&&existing!==server)throw Error('board_instance_mismatch');
    const board=this.board(),now=Date.now();
    if(!existing){
      board.seed(kv.get('leaders')||[],now);
      kv.put('admin:server',server);
    }
    let due=kv.get('admin:nextReset');
    if(!Number.isSafeInteger(due)||due<=0){
      due=nextResetAt(now,server);
      kv.put('admin:nextReset',due);
      await this.ctx.storage.setAlarm(due);
    }
    // Repair a previously scheduled alarm if the Bangkok weekday rule changed.
    if(due>now&&due!==nextResetAt(now,server)){
      due=nextResetAt(now,server);kv.put('admin:nextReset',due);
      await this.ctx.storage.setAlarm(due);
    }
    if(due<=now){
      board.reset({server,at:due,mode:'auto',actor:'scheduler'});
      kv.put('leaders',[]);
      due=nextResetAt(now,server);
      kv.put('admin:nextReset',due);
      await this.ctx.storage.setAlarm(due);
    }
    return board;
  }
  async alarm(){
    const server=this.ctx.storage.kv.get('admin:server');
    if(server==='free'||server==='vip')await this.ensureBoard(server);
  }
  async credit({id,name,avatar,gameId,points=10,server}){
    if(points!==10&&points!==20)return false;
    return this.award({id,name,avatar,gameId,points,kind:'win',server});
  }
  async creditPrize({id,name,avatar,gameId,points,server}){
    if(!LUCKY_PRIZES.some(p=>p.points===points))return false;
    return this.award({id,name,avatar,gameId,points,kind:'box',server});
  }
  async award({id,name,avatar,gameId,points,kind,server}){
    if(!validId(id)||!validRoom(gameId)||!['win','box'].includes(kind)||!Number.isInteger(points))return false;
    const board=await this.ensureBoard(server);
    const key='award:'+kind+':'+gameId;
    if(this.ctx.storage.kv.get(key))return false;
    if(!board.creditOnce({awardId:key,id,name,avatar,points}))return false;
    this.ctx.storage.kv.put(key,id);
    this.ctx.storage.kv.put('leaders',board.leaders());
    return true;
  }
  async getLeaders(server){const b=await this.ensureBoard(server);return b.leaders();}
  async rename({id,name,server}){
    const b=await this.ensureBoard(server);
    const changed=b.rename({id,name});
    if(changed)this.ctx.storage.kv.put('leaders',b.leaders());
    return changed;
  }
  async heartbeat({id,email,name,avatar,server}){
    const b=await this.ensureBoard(server);
    return {ok:b.touch({id,email,name,avatar,online:true})};
  }
  async onlineCount(server){
    const board=await this.ensureBoard(server);
    return {server,online:board.onlineCount(),asOf:Date.now(),windowSeconds:90};
  }
  async adminPlayers({server,onlineOnly=false,limit=150,offset=0}){
    const b=await this.ensureBoard(server);
    return {ok:true,server,...b.players({onlineOnly,limit,offset}),nextReset:this.ctx.storage.kv.get('admin:nextReset'),serverTime:Date.now()};
  }
  async adminEdit({server,uid,name,score,actor}){
    const b=await this.ensureBoard(server);
    const result=b.edit({uid,name,score},actor);
    if(result.ok)this.ctx.storage.kv.put('leaders',b.leaders());
    return result;
  }
  async adminReset({server,actor}){
    const b=await this.ensureBoard(server);
    const result=b.reset({at:Date.now(),mode:'manual',actor,server});
    this.ctx.storage.kv.put('leaders',[]);
    return {...result,nextReset:this.ctx.storage.kv.get('admin:nextReset')};
  }
  async adminExport({server,limit=250,offset=0,actor}){
    const b=await this.ensureBoard(server);
    const result=b.exportPage({limit,offset});
    if(offset===0&&typeof actor==='string')b.audit(actor,'export_scores',null,server+':'+result.total);
    return {ok:true,server,at:Date.now(),nextReset:this.ctx.storage.kv.get('admin:nextReset'),...result};
  }
  async adminHistory({server}){
    const b=await this.ensureBoard(server);
    return {ok:true,server,nextReset:this.ctx.storage.kv.get('admin:nextReset'),history:b.history()};
  }
  async adminAudit({server}){
    const b=await this.ensureBoard(server);
    return {ok:true,server,actions:b.audits()};
  }
}

// One globally named Durable Object for a hard cap of 100 ACTIVE VIP subscribers.
// There is intentionally NO public checkout/activation endpoint in this prototype.
// Only a future authenticated checkout Worker, *after* verifying payment on the
// provider's server-to-server API, may call reserveForCheckout/activateAfterVerifiedPayment.
// Never take paid/verified data from the browser.
export class VipMemberships extends DurableObject {
  state(){return this.ctx.storage.kv.get('vip:registry')||{members:{},holds:{},receipts:{}};}
  save(v){this.ctx.storage.kv.put('vip:registry',v);}
  clean(v,now){
    for(const [id,m] of Object.entries(v.members))if(m.expiresAt<=now)delete v.members[id];
    for(const [id,h] of Object.entries(v.holds))if(h.expiresAt<=now)delete v.holds[id];
    return v;
  }
  statusData(v){
    const active=Object.keys(v.members).length;
    const reserved=Object.keys(v.holds).filter(id=>!v.members[id]).length;
    return {limit:VIP_LIMIT,active,reserved,available:Math.max(0,VIP_LIMIT-active-reserved),full:active+reserved>=VIP_LIMIT};
  }
  async getStatus(){
    const now=Date.now();const v=this.clean(this.state(),now);this.save(v);
    return this.statusData(v);
  }
  // Internal only: requires authenticated userId and unique provider orderId.
  async reserveForCheckout({userId,orderId}){
    if(typeof userId!=='string'||!userId||typeof orderId!=='string'||!orderId)return {ok:false,reason:'invalid_order'};
    const now=Date.now(),v=this.clean(this.state(),now);
    const hold=v.holds[userId];
    if(hold){return hold.orderId===orderId?{ok:true,expiresAt:hold.expiresAt}:{ok:false,reason:'existing_hold'};}
    // Renewing a currently active membership never consumes a second slot.
    if(!v.members[userId]&&this.statusData(v).full)return {ok:false,reason:'vip_full'};
    const expiresAt=now+15*60_000;
    v.holds[userId]={orderId,expiresAt};this.save(v);
    return {ok:true,expiresAt};
  }
  // Internal only: caller must have validated settled transaction with payment provider.
  async activateAfterVerifiedPayment({userId,orderId,transactionId}){
    if(typeof userId!=='string'||!userId||typeof orderId!=='string'||!orderId||typeof transactionId!=='string'||!transactionId)return {ok:false,reason:'invalid_payment'};
    const now=Date.now(),v=this.clean(this.state(),now);
    if(v.receipts[transactionId])return v.receipts[transactionId].userId===userId&&v.receipts[transactionId].orderId===orderId
      ? {ok:true,alreadyApplied:true,expiresAt:v.receipts[transactionId].expiresAt}
      : {ok:false,reason:'duplicate_receipt'};
    const hold=v.holds[userId];
    if(!hold||hold.orderId!==orderId)return {ok:false,reason:'missing_or_expired_hold'};
    if(!v.members[userId]&&Object.keys(v.members).length>=VIP_LIMIT)return {ok:false,reason:'vip_full'};
    const expiresAt=Math.max(now,v.members[userId]?.expiresAt||now)+VIP_DURATION_MS;
    v.members[userId]={expiresAt};delete v.holds[userId];
    v.receipts[transactionId]={userId,orderId,expiresAt};
    this.save(v);return {ok:true,expiresAt};
  }
  async hasAccess(userId){const v=this.clean(this.state(),Date.now());this.save(v);return Boolean(v.members[userId]);}
}
