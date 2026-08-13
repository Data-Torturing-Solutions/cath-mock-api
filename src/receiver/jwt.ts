/**
 * HS256 JWTs on Web Crypto. No libraries -- `crypto.subtle` is enough, and a
 * JWT library on a Worker is a dependency you have to keep patched forever.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Claims {
  iss: string;
  aud: string;
  sub: string;
  scope: string;
  iat: number;
  exp: number;
  [extra: string]: unknown;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(claims: Claims, signingKey: string): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${body}`;

  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(signingKey),
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  requiredScope?: string;
  /** Injectable so tests can pin expiry behaviour. */
  now?: number;
}

export type VerifyResult =
  | { valid: true; claims: Claims }
  | { valid: false; reason: string };

export async function verifyJwt(
  token: string,
  signingKey: string,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const segments = token.split('.');
  if (segments.length !== 3) return { valid: false, reason: 'malformed token' };
  const [headerB64, bodyB64, signatureB64] = segments as [string, string, string];

  let header: { alg?: string };
  try {
    header = JSON.parse(decoder.decode(base64UrlDecode(headerB64)));
  } catch {
    return { valid: false, reason: 'malformed header' };
  }
  // Reject `alg: none` and algorithm substitution explicitly.
  if (header.alg !== 'HS256') return { valid: false, reason: `unsupported alg ${header.alg}` };

  const verified = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(signingKey),
    base64UrlDecode(signatureB64) as unknown as ArrayBuffer,
    encoder.encode(`${headerB64}.${bodyB64}`),
  );
  if (!verified) return { valid: false, reason: 'bad signature' };

  let claims: Claims;
  try {
    claims = JSON.parse(decoder.decode(base64UrlDecode(bodyB64)));
  } catch {
    return { valid: false, reason: 'malformed claims' };
  }

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) return { valid: false, reason: 'expired' };
  if (typeof claims.iat === 'number' && claims.iat > now + 60) {
    return { valid: false, reason: 'issued in the future' };
  }
  if (claims.iss !== options.issuer) return { valid: false, reason: 'wrong issuer' };
  if (claims.aud !== options.audience) return { valid: false, reason: 'wrong audience' };

  if (options.requiredScope) {
    const scopes = String(claims.scope ?? '').split(/\s+/).filter(Boolean);
    if (!scopes.includes(options.requiredScope)) return { valid: false, reason: 'missing scope' };
  }

  return { valid: true, claims };
}

/**
 * Constant-time string comparison for the client secret. Length is allowed to
 * leak; the contents are not.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
