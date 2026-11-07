// Firebase ID-token verification on Cloudflare Workers using WebCrypto; no Firebase Admin secret in browser.
const KEY_URL='https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let cachedKeys=null,cacheUntil=0;
function decode64url(input){
  if(typeof input!=='string'||!/^[-_A-Za-z0-9]+$/.test(input))throw Error('invalid token encoding');
  const s=input.replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(s+'='.repeat((4-s.length%4)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
function parsePart(part){return JSON.parse(new TextDecoder().decode(decode64url(part)));}
async function getJwk(kid){
  const now=Date.now();
  if(!cachedKeys||now>=cacheUntil){
    const response=await fetch(KEY_URL,{headers:{Accept:'application/json'}});
    if(!response.ok)throw Error('key service unavailable');
    const body=await response.json();
    if(!Array.isArray(body.keys))throw Error('invalid key data');
    cachedKeys=body.keys;
    const maxAge=Number(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1]||300);
    cacheUntil=now+Math.min(3600,Math.max(60,maxAge))*1000;
  }
  let found=cachedKeys.find(k=>k.kid===kid&&k.kty==='RSA'&&k.alg==='RS256');
  if(!found){cachedKeys=null;cacheUntil=0;throw Error('unknown signing key');}
  return found;
}
export async function verifyFirebaseToken(token,projectId){
  if(!projectId||typeof token!=='string'||token.length>7000)throw Error('invalid auth configuration');
  const parts=token.split('.');if(parts.length!==3)throw Error('malformed token');
  const header=parsePart(parts[0]),payload=parsePart(parts[1]);
  if(header.alg!=='RS256'||typeof header.kid!=='string')throw Error('unsupported signature');
  const jwk=await getJwk(header.kid);
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const verified=await crypto.subtle.verify({name:'RSASSA-PKCS1-v1_5'},key,decode64url(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
  if(!verified)throw Error('invalid signature');
  const now=Math.floor(Date.now()/1000);
  if(payload.aud!==projectId||payload.iss!==`https://securetoken.google.com/${projectId}`||
     typeof payload.sub!=='string'||!payload.sub||payload.sub.length>128||
     !Number.isFinite(payload.iat)||payload.iat>now||
     !Number.isFinite(payload.exp)||payload.exp<=now||
     !Number.isFinite(payload.auth_time)||payload.auth_time>now||
     payload.firebase?.sign_in_provider!=='google.com'||payload.email_verified!==true)throw Error('invalid token claims');
  return {id:payload.sub,email:payload.email||null};
}
export async function getAuthorizedUser(request,env){
  const authorization=request.headers.get('Authorization')||'';
  if(!authorization.startsWith('Bearer ')||!env.FIREBASE_PROJECT_ID)return null;
  try{return await verifyFirebaseToken(authorization.slice(7),env.FIREBASE_PROJECT_ID);}
  catch{return null;}
}
export function requireSameOrigin(request){
  const origin=request.headers.get('Origin');
  return !origin||origin===new URL(request.url).origin;
}
