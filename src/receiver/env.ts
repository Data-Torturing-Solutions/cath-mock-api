export type AuthMode = 'off' | 'optional' | 'required';
export type ValidationMode = 'strict' | 'lenient';

export interface Env {
  DB: D1Database;
  ARTEFACTS: R2Bucket;

  /** off | optional | required. Anything else is treated as `required`. */
  AUTH_MODE?: string;
  /** strict = 4xx on invalid metadata (spec conformance). lenient = accept and quarantine. */
  VALIDATION_MODE?: string;
  /** Mount point for the four CaTH endpoints. This is the BaseURL you hand HMCTS. */
  BASE_PATH?: string;
  OAUTH_SCOPE?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  TOKEN_TTL_SECONDS?: string;
  CATH_CLIENT_ID?: string;

  /** Secrets -- `wrangler secret put`, never wrangler.toml. */
  CATH_CLIENT_SECRET?: string;
  JWT_SIGNING_KEY?: string;
  ADMIN_TOKEN?: string;
}

/**
 * Fail closed. An unset or misspelled AUTH_MODE must not silently open the API,
 * so only the three known values are honoured and everything else is
 * `required`.
 */
export function resolveAuthMode(env: Env): AuthMode {
  switch (env.AUTH_MODE) {
    case 'off':
    case 'optional':
    case 'required':
      return env.AUTH_MODE;
    default:
      return 'required';
  }
}

export function resolveValidationMode(env: Env): ValidationMode {
  return env.VALIDATION_MODE === 'lenient' ? 'lenient' : 'strict';
}

export function basePath(env: Env): string {
  const raw = (env.BASE_PATH ?? '/publications').trim();
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

export function tokenTtlSeconds(env: Env): number {
  const parsed = Number.parseInt(env.TOKEN_TTL_SECONDS ?? '3600', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 86_400 ? parsed : 3600;
}
