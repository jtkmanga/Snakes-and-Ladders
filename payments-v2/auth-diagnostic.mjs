// Payment V2: read-only Slip2Go authentication parity probe.
// The official REST API requires Authorization: SECRET. The older VOXEL worker
// used Authorization: Bearer SECRET. This module compares the two only in an
// authenticated, owner-only diagnostic route; never use fallback for purchases.
// Do not expose this diagnostic as a public unauthenticated endpoint.
const ACCOUNT_INFO_URL = 'https://connect.slip2go.com/api/account/info';
const SAFE_CODES=new Set(['200001','401001','401002','401003','401004','401005','401006','401007','429000','500500','500503']);
const MAX_ATTEMPTS=2;

function safeCode(code) {
  return typeof code==='string' && SAFE_CODES.has(code) ? code : 'unexpected';
}
function normalizedSecret(env) {
  const s=env?.SLIP2GO_V2_SECRET;
  if(typeof s!=='string'||!s)throw Error('missing_v2_secret');
  if(s!==s.trim()||/[\r\n\0-\x1f\x7f]/.test(s)||/^(?:Bearer|Basic)\s/i.test(s)||/^["']|["']$/.test(s))
    throw Error('credential_format');
  return s;
}
export async function probeAuthMode(env, { mode='documented', fetchFn=fetch } = {}) {
  if(mode!=='documented'&&mode!=='legacy-bearer')throw Error('invalid_diagnostic_mode');
  const secret=normalizedSecret(env);
  const authorization=mode==='documented'?secret:'Bearer '+secret;
  let response;
  try {
    response=await fetchFn(ACCOUNT_INFO_URL,{
      method:'GET',
      headers:{Authorization:authorization,Accept:'application/json','Cache-Control':'no-store'},
      redirect:'manual',
      signal:AbortSignal.timeout(10000)
    });
  } catch {
    return {mode,authenticated:false,reason:'network_or_timeout',providerCode:null,httpStatus:null};
  }
  const httpStatus=Number.isInteger(response?.status)?response.status:null;
  let data=null;
  try {data=await response.json();}catch{}
  const providerCode=safeCode(data?.code);
  const authenticated=response?.ok===true && providerCode==='200001'
       &&data?.data && typeof data.data==='object' && !Array.isArray(data.data);
  // Important: no secret, account number, raw provider message/body, or QR is returned.
  return {mode,authenticated:Boolean(authenticated),
    reason:authenticated?'ok':providerCode==='unexpected'?'unrecognized_provider_response':'provider_rejected',
    providerCode,httpStatus};
}
export async function compareAuthModes(env,opts={}) {
  // Must be invoked ONLY behind same-origin, verified Firebase ID token + admin allowlist.
  // Both probes are read-only GETs to exactly the same pinned Slip2Go origin.
  const documented=await probeAuthMode(env,{...opts,mode:'documented'});
  if(documented.authenticated||documented.providerCode!=='401001')
    return {documented,legacyBearer:null,verdict:documented.authenticated?'documented_key_valid':'not_an_auth_scheme_comparison'};
  const legacyBearer=await probeAuthMode(env,{...opts,mode:'legacy-bearer'});
  return {documented,legacyBearer,verdict:legacyBearer.authenticated?
    'legacy_only_passed_manual_provider_verification_required':
    'neither_scheme_authenticated'};
}
export {ACCOUNT_INFO_URL,MAX_ATTEMPTS};
