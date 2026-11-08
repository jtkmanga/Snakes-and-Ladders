// Snakes & Ladders Payment V2 - pure, side-effect-free validation.
// Not connected to the live Worker until a new provider key and checkout audit pass.
// Never put bank account identifiers, API secrets, or slip images in the browser.
export const PRODUCTS_V2=Object.freeze({
  vip:Object.freeze({amountBaht:100,days:30,type:'vip'}),
  shield:Object.freeze({amountBaht:10,hours:24,type:'item'}),
  win2:Object.freeze({amountBaht:20,hours:24,type:'item'})
});
export const ORDER_TTL_MS=15*60*1000;
const RECOVERY_MS=24*60*60*1000;
const CLOCK_SKEW_MS=120000;
const VALID_SKU=new Set(Object.keys(PRODUCTS_V2));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPendingOrder({uid,sku,uuid,now=Date.now()}){
  if(typeof uid!=='string'||uid.length<4||uid.length>200)throw Error('invalid_user');
  if(!VALID_SKU.has(sku))throw Error('invalid_product');
  if(typeof uuid!=='string'||!UUID.test(uuid))throw Error('invalid_order_id');
  if(!Number.isSafeInteger(now)||now<=0)throw Error('invalid_time');
  return Object.freeze({id:'payv2-'+uuid,uid,sku,amountBaht:PRODUCTS_V2[sku].amountBaht,
    createdAt:now,expiresAt:now+ORDER_TTL_MS,status:'pending',version:2});
}

export function makeProviderChecks(order,receiver){
  if(!order||order.version!==2||!VALID_SKU.has(order.sku)
      ||PRODUCTS_V2[order.sku].amountBaht!==order.amountBaht)throw Error('invalid_order');
  const receiverPatterns={
    '02001':/^0[689]\d{8}$/, // PromptPay mobile
    '02003':/^\d{13}$/,       // PromptPay national ID
    '02004':/^\d{15}$/,       // PromptPay E-Wallet ID
    '03000':/^\d{6,32}$/     // Merchant QR; not enabled for E-Wallet purchases
  };
  if(!receiver||typeof receiver.accountType!=='string'
      ||typeof receiver.accountNumber!=='string'
      ||typeof receiverPatterns[receiver.accountType]?.test!=='function'
      ||!receiverPatterns[receiver.accountType].test(receiver.accountNumber)
      ||receiver.accountType!=='02004')throw Error('invalid_receiver');
  return {
    checkDuplicate:true,
    checkReceiver:[{accountType:receiver.accountType,accountNumber:receiver.accountNumber,
      ...(receiver.accountNameTH?{accountNameTH:String(receiver.accountNameTH).trim()}: {})}],
    checkAmount:{type:'eq',amount:String(order.amountBaht)}
  };
}

// Only a 200200 response to a request made with makeProviderChecks can be considered.
// A 200000 "Slip found" is NOT payment approval. These functions do not grant items.
export function validateProviderSlip(answer,order,{now=Date.now()}={}){
  if(!order||order.version!==2||!['pending','verifying'].includes(order.status))throw Error('invalid_order');
  if(String(answer?.code)!=='200200')throw Error('provider_checks_not_passed');
  const data=answer?.data;
  if(!data||!Number.isFinite(Number(data.amount))||Number(data.amount)!==order.amountBaht)
    throw Error('amount_mismatch');
  const transaction=typeof data.transRef==='string'?data.transRef.trim():'';
  if(transaction.length<8||transaction.length>200||! /^[A-Za-z0-9._-]+$/.test(transaction))
    throw Error('invalid_transfer_reference');
  const bank=typeof data.sender?.bank?.id==='string'?data.sender.bank.id.trim():'';
  if(!/^[0-9]{3,5}$/.test(bank))throw Error('invalid_sender_bank');
  const transferredAt=Date.parse(data.dateTime);
  if(!Number.isFinite(transferredAt)||transferredAt<order.createdAt-CLOCK_SKEW_MS
      ||transferredAt>order.expiresAt+60000||transferredAt>now+60000)
    throw Error('transfer_outside_order_window');
  if(now>order.createdAt+RECOVERY_MS)throw Error('recovery_window_expired');
  return Object.freeze({transactionRef:bank+':'+transaction,amountBaht:order.amountBaht,
    transferredAt,orderId:order.id,version:2});
}

export async function transferFingerprint(verified){
  if(!verified||!verified.transactionRef)throw Error('missing_transfer');
  const data=new TextEncoder().encode('snl-payment-v2|'+verified.transactionRef);
  const digest=await crypto.subtle.digest('SHA-256',data);
  return Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
}

export function providerAccountReady(account,{expectedShopName,now=Date.now()}){
  const name=String(account?.shopName||'').trim().normalize('NFC').toLowerCase();
  const expected=String(expectedShopName||'').trim().normalize('NFC').toLowerCase();
  if(!name||!expected||name!==expected)return {ok:false,reason:'shop_mismatch'};
  const expires=Date.parse(account?.packageExpiredDate);
  if(!Number.isFinite(expires)||expires<=now)return {ok:false,reason:'package_unavailable'};
  const tokens=Number(account.tokenRemaining);
  const cost=Number(account.tokenPerSlip);
  const tokenReady=Number.isFinite(tokens)&&tokens>0&&
    (Number.isFinite(cost)?cost<=tokens:true);
  const creditReady=account.checkSlipByCredit===true&&Number(account.creditRemaining)>0;
  if(!tokenReady&&!creditReady)return {ok:false,reason:'no_quota'};
  return {ok:true};
}
