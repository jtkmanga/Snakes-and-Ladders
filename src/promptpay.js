// PromptPay merchant-presented QR, Bank of Thailand EMV/Thai QR format.
// Phone is never returned as text in the game's public JSON/HTML.
// IMPORTANT: a QR payment code still contains the identifier and is decodable.
export function normalizePromptPayPhone(input){
  const phone=String(input??'').trim();
  if(!/^0[689]\d{8}$/.test(phone))throw new Error('Invalid Thai PromptPay phone');
  return phone;
}
function tlv(tag,val){
  if(!/^\d{2}$/.test(tag)||val.length>99)throw Error('Invalid EMV field');
  return tag+String(val.length).padStart(2,'0')+val;
}
export function crc16CcittFalse(data){
  let crc=0xffff;
  for(let i=0;i<data.length;i++){
    crc^=data.charCodeAt(i)<<8;
    for(let j=0;j<8;j++)crc=(crc&0x8000)?((crc<<1)^0x1021)&0xffff:(crc<<1)&0xffff;
  }
  return crc.toString(16).padStart(4,'0').toUpperCase();
}
export function createPromptPayPayload(phone,amount){
  const target=normalizePromptPayPhone(phone);
  if(!Number.isSafeInteger(amount)||amount<1||amount>100000)throw Error('Invalid order amount');
  const receiver=tlv('00','A000000677010111')+tlv('01','0066'+target.slice(1));
  const prefix=tlv('00','01')+tlv('01','12')+tlv('29',receiver)
    +tlv('58','TH')+tlv('53','764')+tlv('54',amount.toFixed(2))+'6304';
  return prefix+crc16CcittFalse(prefix);
}
