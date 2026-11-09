// Server-owned prices, not browser amounts. A paid order locks its amount at creation.
export const DEFAULT_PRICES=Object.freeze({vip:100,shield:10,win2:20});
export const MAX_PRICE_BAHT=5000;
export function checkedPrices(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='shield,vip,win2')
  throw Error('invalid_price_map');
 const result={};
 for(const sku of ['vip','shield','win2']){
  const price=p[sku];
  if(!Number.isSafeInteger(price)||price<1||price>MAX_PRICE_BAHT)throw Error('price_out_of_range');
  result[sku]=price;
 }
 return result;
}
export function currentPrices(saved){
 try{return checkedPrices(saved)}catch{return {...DEFAULT_PRICES}}
}
