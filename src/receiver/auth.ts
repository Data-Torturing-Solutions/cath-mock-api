/**
 * Auth for a service where the direction is inverted: HMCTS is the client and
 * we are the identity provider. They fetch a bearer token from us and present
 * it back on every push.
 */
import { resolveAuthMode, tokenTtlSeconds, type Env } from './env.js';
import { signJwt, timingSafeEqual, verifyJwt, type Claims } from './jwt.js';

export interface AuthResult {
  /** An Authorization header was present, whatever its quality. */
  present: boolean;
  valid: boolean;
  claims?: Claims;
  reason?: string;
}

function issuer(env: Env): string {
  return env.JWT_ISSUER ?? 'https://cath.opencourtdata.uk';
}

function audience(env: Env): string {
  return env.JWT_AUDIENCE ?? 'cath-receiver';
}

function scope(env: Env): string {
  return env.OAUTH_SCOPE ?? 'cath.publish';
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const header = request.headers.get('authorization');
  if (!header) return { present: false, valid: false, reason: 'no Authorization header' };

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return { present: true, valid: false, reason: 'Authorization header is not Bearer' };

  if (!env.JWT_SIGNING_KEY) {
    return { present: true, valid: false, reason: 'JWT_SIGNING_KEY is not configured' };
  }

  const result = await verifyJwt(match[1] as string, env.JWT_SIGNING_KEY, {
    issuer: issuer(env),
    audience: audience(env),
    requiredScope: scope(env),
  });

  return result.valid
    ? { present: true, valid: true, claims: result.claims }
    : { present: true, valid: false, reason: result.reason };
}

/**
 * Whether a write request may proceed, given AUTH_MODE. `off` accepts
 * everything, `optional` accepts either path but records which was used, and
 * `required` (also the fallback for a misspelled value) rejects without a
 * valid token.
 */
export function authorizeWrite(env: Env, auth: AuthResult): { allowed: boolean; reason?: string } {
  const mode = resolveAuthMode(env);
  if (mode === 'off') return { allowed: true };
  if (mode === 'optional') return { allowed: true };
  return auth.valid
    ? { allowed: true }
    : { allowed: false, reason: auth.reason ?? 'authentication required' };
}

export interface TokenRequest {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
}

export type TokenResponse =
  | { ok: true; body: { access_token: string; token_type: 'Bearer'; expires_in: number; scope: string } }
  | { ok: false; status: number; body: { error: string; error_description: string } };

export async function issueToken(env: Env, form: TokenRequest): Promise<TokenResponse> {
  if (!env.CATH_CLIENT_SECRET || !env.JWT_SIGNING_KEY) {
    return {
      ok: false,
      status: 500,
      body: {
        error: 'server_error',
        error_description: 'CATH_CLIENT_SECRET and JWT_SIGNING_KEY must be set as secrets',
      },
    };
  }

  if (form.grant_type !== 'client_credentials') {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'unsupported_grant_type',
        error_description: 'only client_credentials is supported',
      },
    };
  }

  const expectedId = env.CATH_CLIENT_ID ?? 'hmcts-cath';
  // Both compared in constant time so a wrong client_id and a wrong secret
  // take the same path.
  const idOk = timingSafeEqual(form.client_id ?? '', expectedId);
  const secretOk = timingSafeEqual(form.client_secret ?? '', env.CATH_CLIENT_SECRET);
  if (!idOk || !secretOk) {
    return {
      ok: false,
      status: 401,
      body: { error: 'invalid_client', error_description: 'client authentication failed' },
    };
  }

  const requested = scope(env);
  if (form.scope && form.scope.trim() !== '' && !form.scope.split(/\s+/).includes(requested)) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalid_scope', error_description: `scope must include ${requested}` },
    };
  }

  const ttl = tokenTtlSeconds(env);
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    {
      iss: issuer(env),
      aud: audience(env),
      sub: expectedId,
      scope: requested,
      iat: now,
      exp: now + ttl,
    } satisfies Claims,
    env.JWT_SIGNING_KEY,
  );

  return {
    ok: true,
    body: { access_token: token, token_type: 'Bearer', expires_in: ttl, scope: requested },
  };
}

/**
 * Read-side gating, deliberately independent of AUTH_MODE.
 *
 * PRIVATE and CLASSIFIED publications must never be served from an open
 * endpoint. With simulator data that is harmless; the moment a real CaTH feed
 * points here it would be an open-justice breach, so the safe behaviour is
 * wired in from the start rather than added later.
 */
export function canRead(sensitivity: string, auth: AuthResult): boolean {
  return sensitivity === 'PUBLIC' || auth.valid;
}

export function readableSensitivities(auth: AuthResult): string[] {
  return auth.valid ? ['PUBLIC', 'PRIVATE', 'CLASSIFIED'] : ['PUBLIC'];
}
