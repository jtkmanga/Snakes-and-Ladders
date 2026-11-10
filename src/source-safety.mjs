import path from 'node:path';

/**
 * Conservative warnings only. Never treat a negative scan as proof that
 * source is safe to publish. Payment data may have many unrecognized forms.
 */
export function sourceRiskFlags(source) {
  const text=String(source);
  return {
    transferReferences: /\bMTI\d{14,}\b|\bpayv2-[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b0046000600\d{12,}\b/i.test(text),
    personalIdentifiers: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|นาย\s+[\p{Script=Thai}]{2,}/iu.test(text),
    walletOrAccountNumbers: /\b\d{13,17}\b/.test(text),
    embeddedCredential: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:token|secret|password|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/i.test(text),
  };
}

export function requiresPrivateReview(source) {
  return Object.values(sourceRiskFlags(source)).some(Boolean);
}

export function safeModulePath(name) {
  if (typeof name!=='string' || !name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Unsafe module filename');
  }
  const segments=name.split('/');
  if(segments.some(segment=>!segment || segment==='.' || segment==='..' || !/^[\w.-]+$/.test(segment))) {
    throw new Error('Unsafe module filename');
  }
  return name;
}

export function privateExportLocation(cwd,destination) {
  if (!destination) throw new Error('Supply --output <directory-outside-the-public-repository>');
  const repository=path.resolve(cwd);
  const target=path.resolve(cwd,destination);
  const inside=path.relative(repository,target);
  if (inside===''||(!inside.startsWith('..'+path.sep)&&inside!=='..'&&!path.isAbsolute(inside))) {
    throw new Error('Refusing to place sensitive Worker source inside the public GitHub checkout');
  }
  if (target===path.parse(target).root) throw new Error('Refusing to write to filesystem root');
  return target;
}
