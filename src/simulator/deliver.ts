/**
 * Delivery with CaTH's retry semantics.
 *
 * "Any non-2xx and CaTH retries three more times." That is four attempts in
 * total for the same publicationId, which is exactly why the receiver has to
 * be idempotent -- and why the simulator does it for real rather than
 * pretending.
 */
import type { SimulatorEnv } from './env.js';

export interface Attempt {
  attempt: number;
  status: number;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface DeliveryResult {
  method: string;
  url: string;
  publicationId: string | null;
  attempts: Attempt[];
  delivered: boolean;
  /** Attempts beyond the first. Non-zero means the receiver made CaTH retry. */
  retries: number;
}

export interface DeliverOptions {
  method: 'POST' | 'PUT' | 'DELETE' | 'GET';
  url: string;
  body?: FormData | string | null;
  contentType?: string;
  publicationId?: string | null;
  token?: string | null;
  retryCount?: number;
}

export async function deliver(env: SimulatorEnv, options: DeliverOptions): Promise<DeliveryResult> {
  const retryCount = options.retryCount ?? Number.parseInt(env.RETRY_COUNT ?? '3', 10);
  const maxAttempts = Math.max(1, (Number.isFinite(retryCount) ? retryCount : 3) + 1);

  const attempts: Attempt[] = [];
  let delivered = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    const headers: Record<string, string> = {};
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    if (options.contentType) headers['content-type'] = options.contentType;

    try {
      const response = await fetch(options.url, {
        method: options.method,
        headers,
        // FormData sets its own multipart boundary; never set it by hand.
        body: options.body ?? undefined,
      });

      const ok = response.status >= 200 && response.status < 300;
      attempts.push({
        attempt,
        status: response.status,
        ok,
        durationMs: Date.now() - startedAt,
        ...(ok ? {} : { error: (await response.text()).slice(0, 300) }),
      });

      if (ok) {
        delivered = true;
        break;
      }
    } catch (err) {
      attempts.push({
        attempt,
        status: 0,
        ok: false,
        error: (err as Error).message,
        durationMs: Date.now() - startedAt,
      });
    }

    // Note: a FormData body is re-serialised per fetch in workerd, so the same
    // object can be resent. Verified end to end -- a rejected chaos push
    // returns the same 422 on all four attempts, which it could not do if the
    // retries were sending an empty body.
  }

  return {
    method: options.method,
    url: options.url,
    publicationId: options.publicationId ?? null,
    attempts,
    delivered,
    retries: Math.max(0, attempts.length - 1),
  };
}

/**
 * Fetches a bearer token from the receiver's token endpoint, exactly as HMCTS
 * would. Returns null when no client secret is configured, which is the
 * unauthenticated path `AUTH_MODE=optional` exists to exercise.
 */
export async function fetchToken(env: SimulatorEnv): Promise<string | null> {
  if (!env.CLIENT_SECRET || !env.TOKEN_URL) return null;

  const response = await fetch(env.TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.CLIENT_ID ?? 'hmcts-cath',
      client_secret: env.CLIENT_SECRET,
      scope: env.OAUTH_SCOPE ?? 'cath.publish',
    }),
  });

  if (!response.ok) {
    console.warn(`token request failed: ${response.status} ${await response.text()}`);
    return null;
  }

  const body = (await response.json()) as { access_token?: string };
  return body.access_token ?? null;
}
