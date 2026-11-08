// PromptPay E-Wallet QR payload for Snakes & Ladders Payment V2.
// Bank of Thailand Thai QR merchant-presented format, PromptPay Tag 29 / subtag 03.
// This helper never sends funds, submits orders, or authorizes checkout.
const AID='A000000677010111';
function tlv(tag,value) {
  if (!/^\d{2}$/.test(tag)||typeof value!=='string'||value.length>99)
    throw new Error('invalid_tlv');
  return tag+String(value.length).padStart(2,'0')+value;
}
export function validateEWalletId(accountNumber) {
  return typeof accountNumber==='string' && /^\d{15}$/.test(accountNumber);
}
export function crc16CcittFalse(input) {
  let crc=0xFFFF;
  for(let i=0;i<input.length;i++){
    crc ^= input.charCodeAt(i)<<8;
    for(let j=0;j<8;j++)crc=(crc&0x8000)?((crc<<1)^0x1021)&0xFFFF:(crc<<1)&0xFFFF;
  }
  return crc.toString(16).padStart(4,'0').toUpperCase();
}
export function buildEWalletPromptPayPayload({accountNumber,amountBaht}) {
  if(!validateEWalletId(accountNumber))throw new Error('invalid_e_wallet_id');
  if(!Number.isSafeInteger(amountBaht)||amountBaht<1||amountBaht>100000)
    throw new Error('invalid_amount');
  const receiver=tlv('00',AID)+tlv('03',accountNumber);
  const prefix=tlv('00','01')+tlv('01','12')+tlv('29',receiver)
   +tlv('58','TH')+tlv('53','764')+tlv('54',amountBaht.toFixed(2))+'6304';
  return prefix+crc16CcittFalse(prefix);
}
// No secret values in source. Worker must read MERCHANT_ACCOUNT_NUMBER (secret_text)
// and MERCHANT_ACCOUNT_TYPE=02004 only after server-side verified receiver configuration.
