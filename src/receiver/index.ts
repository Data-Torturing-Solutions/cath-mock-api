/**
 * cath-receiver -- the four endpoints HMCTS require you to expose, plus the
 * token endpoint they fetch credentials from.
 *
 * This is not a mock. CaTH pushes to you; there is nothing to pull. This
 * Worker is the onboarding deliverable itself.
 *
 *   GET    {BASE_PATH}       health check (HMCTS test the connection)
 *   POST   {BASE_PATH}       new publication          multipart/form-data
 *   PUT    {BASE_PATH}/{id}  superseded publication   multipart/form-data
 *   DELETE {BASE_PATH}/{id}  manually deleted in CaTH
 *   POST   /oauth/token      client_credentials -> bearer token
 *   GET    /admin/*          inspection (sensitivity-gated)
 */
import { validateMetadata } from '../shared/metadata.js';
import { parseCathMultipart } from '../shared/multipart.js';
import { handleAdmin } from './admin.js';
import { authenticate, authorizeWrite, issueToken, type AuthResult } from './auth.js';
import { logDelivery, quarantine } from './deliveries.js';
import { basePath, resolveAuthMode, resolveValidationMode, type Env } from './env.js';
import { expirySweep, softDelete, storePublication } from './store.js';

/** CaTH ignores the response body; only the status code matters. */
function ok(): Response {
  return new Response(null, { status: 200 });
}

function problem(status: number, error: string, detail?: unknown): Response {
  return new Response(JSON.stringify({ error, detail }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return problem(405, 'method_not_allowed');

  const contentType = request.headers.get('content-type') ?? '';
  let form: Record<string, string> = {};

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const body = new URLSearchParams(await request.text());
    form = Object.fromEntries(body.entries());
  } else if (contentType.includes('application/json')) {
    try {
      form = (await request.json()) as Record<string, string>;
    } catch {
      return problem(400, 'invalid_request', 'body is not valid JSON');
    }
  } else {
    return problem(400, 'invalid_request', 'expected application/x-www-form-urlencoded');
  }

  // HTTP Basic is the other half of RFC 6749 client authentication.
  const authorization = request.headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = atob(authorization.slice(6).trim());
      const separator = decoded.indexOf(':');
      if (separator > -1) {
        form.client_id ??= decoded.slice(0, separator);
        form.client_secret ??= decoded.slice(separator + 1);
      }
    } catch {
      // Malformed Basic credentials fall through to invalid_client below.
    }
  }

  const result = await issueToken(env, form);
  return new Response(JSON.stringify(result.body), {
    status: result.ok ? 200 : result.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function handlePublicationWrite(
  request: Request,
  env: Env,
  url: URL,
  auth: AuthResult,
  method: 'POST' | 'PUT',
  pathId: string | null,
  startedAt: number,
): Promise<Response> {
  const parts = await parseCathMultipart(request);

  const finish = async (
    status: number,
    options: {
      publicationId: string | null;
      validationOk: boolean | null;
      outcome: string | null;
      error?: string | null;
      quarantineReason?: string;
    },
  ): Promise<Response> => {
    const deliveryId = await logDelivery(env, {
      publicationId: options.publicationId,
      method,
      path: url.pathname,
      status,
      authUsed: auth.valid,
      validationOk: options.validationOk,
      outcome: options.outcome,
      error: options.error ?? null,
      headers: request.headers,
      durationMs: Date.now() - startedAt,
    });

    if (options.quarantineReason) {
      await quarantine(env, {
        deliveryId,
        publicationId: options.publicationId,
        reason: options.quarantineReason,
        metadataText: parts.metadataText,
        payloadText: parts.payloadText,
        fileBytes: parts.fileBytes,
        fileName: parts.fileName,
      });
    }

    return status === 200 ? ok() : problem(status, options.outcome ?? 'rejected', options.error);
  };

  if (parts.parseError) {
    return finish(400, {
      publicationId: pathId,
      validationOk: false,
      outcome: 'rejected_unparseable',
      error: parts.parseError,
      quarantineReason: parts.parseError,
    });
  }

  if (parts.metadataText === null) {
    return finish(400, {
      publicationId: pathId,
      validationOk: false,
      outcome: 'rejected_no_metadata',
      error: 'the mandatory `metadata` part is missing',
      quarantineReason: 'missing metadata part',
    });
  }

  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(parts.metadataText);
  } catch (err) {
    return finish(400, {
      publicationId: pathId,
      validationOk: false,
      outcome: 'rejected_bad_metadata_json',
      error: `metadata is not valid JSON: ${(err as Error).message}`,
      quarantineReason: 'metadata is not valid JSON',
    });
  }

  const validation = validateMetadata(parsedMetadata);
  const metadataId =
    typeof (parsedMetadata as { publicationId?: unknown })?.publicationId === 'string'
      ? ((parsedMetadata as { publicationId: string }).publicationId)
      : null;

  if (!validation.ok || !validation.value) {
    const strict = resolveValidationMode(env) === 'strict';
    // Either way the bytes are kept. `strict` returns a 4xx so CaTH retries and
    // the failure is visible; `lenient` accepts so nothing is ever dropped.
    if (strict) {
      return finish(422, {
        publicationId: metadataId ?? pathId,
        validationOk: false,
        outcome: 'rejected_invalid_metadata',
        error: validation.errors.join('; '),
        quarantineReason: validation.errors.join('; '),
      });
    }
    return finish(200, {
      publicationId: metadataId ?? pathId,
      validationOk: false,
      outcome: 'accepted_quarantined',
      error: validation.errors.join('; '),
      quarantineReason: validation.errors.join('; '),
    });
  }

  const metadata = validation.value;

  // A PUT carries the id in the path; a mismatch means one of us is confused,
  // so record it and trust the path (that is what CaTH addressed).
  let idMismatch: string | null = null;
  if (pathId && pathId !== metadata.publicationId) {
    idMismatch = `path id ${pathId} does not match metadata publicationId ${metadata.publicationId}`;
    metadata.publicationId = pathId;
  }

  const stored = await storePublication(env, {
    metadata,
    payloadText: parts.payloadText,
    fileBytes: parts.fileBytes,
    fileName: parts.fileName,
    fileMime: parts.fileMime,
    method,
    authUsed: auth.valid,
  });

  const notes = [
    ...validation.warnings,
    ...(idMismatch ? [idMismatch] : []),
    ...(parts.unexpectedParts.length > 0
      ? [`unexpected parts: ${parts.unexpectedParts.join(', ')}`]
      : []),
  ];

  return finish(200, {
    publicationId: metadata.publicationId,
    validationOk: true,
    outcome: stored.outcome,
    error: notes.length > 0 ? notes.join('; ') : null,
  });
}

async function handleDelete(
  request: Request,
  env: Env,
  url: URL,
  auth: AuthResult,
  publicationId: string,
  startedAt: number,
): Promise<Response> {
  const { outcome } = await softDelete(env, publicationId, auth.valid);

  await logDelivery(env, {
    publicationId,
    method: 'DELETE',
    path: url.pathname,
    status: 200,
    authUsed: auth.valid,
    validationOk: true,
    outcome,
    // A DELETE for something we never held is not an error: CaTH may have
    // deleted a publication we rejected, or one that predates us.
    error: outcome === 'delete_unknown' ? 'no publication with that id' : null,
    headers: request.headers,
    durationMs: Date.now() - startedAt,
  });

  // Idempotent by design -- an unknown id still returns 200.
  return ok();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const base = basePath(env);
    const auth = await authenticate(request, env);

    try {
      if (url.pathname === '/oauth/token') return await handleToken(request, env);

      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        return await handleAdmin(request, env, url, auth);
      }

      const onBase = url.pathname === base || url.pathname === `${base}/`;
      const underBase = url.pathname.startsWith(base === '/' ? '/' : `${base}/`);
      const publicationId = onBase
        ? null
        : underBase
          ? decodeURIComponent(url.pathname.slice(base === '/' ? 1 : base.length + 1)).split('/')[0] ?? null
          : null;

      if (!onBase && !publicationId) return problem(404, 'not_found', `no route for ${url.pathname}`);

      // The health check discloses nothing, so it stays open even in
      // `required` mode -- HMCTS test the connection before auth is agreed.
      if (onBase && request.method === 'GET') {
        ctx.waitUntil(
          logDelivery(env, {
            publicationId: null,
            method: 'GET',
            path: url.pathname,
            status: 200,
            authUsed: auth.valid,
            validationOk: null,
            outcome: 'health_check',
            error: null,
            headers: request.headers,
            durationMs: Date.now() - startedAt,
          }),
        );
        return new Response(
          JSON.stringify({
            status: 'ok',
            service: 'cath-receiver',
            authMode: resolveAuthMode(env),
            basePath: base,
            time: new Date().toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
        );
      }

      const authorized = authorizeWrite(env, auth);
      if (!authorized.allowed) {
        await logDelivery(env, {
          publicationId,
          method: request.method,
          path: url.pathname,
          status: 401,
          authUsed: false,
          validationOk: null,
          outcome: 'rejected_unauthorized',
          error: authorized.reason ?? null,
          headers: request.headers,
          durationMs: Date.now() - startedAt,
        });
        return new Response(
          JSON.stringify({ error: 'unauthorized', detail: authorized.reason }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'www-authenticate': 'Bearer realm="cath", error="invalid_token"',
            },
          },
        );
      }

      if (onBase && request.method === 'POST') {
        return await handlePublicationWrite(request, env, url, auth, 'POST', null, startedAt);
      }
      if (publicationId && request.method === 'PUT') {
        return await handlePublicationWrite(request, env, url, auth, 'PUT', publicationId, startedAt);
      }
      if (publicationId && request.method === 'DELETE') {
        return await handleDelete(request, env, url, auth, publicationId, startedAt);
      }

      return problem(405, 'method_not_allowed', `${request.method} ${url.pathname}`);
    } catch (err) {
      // Never lose the record of a request, even one that blew up: a 500 is
      // retried by CaTH, and we want the evidence of why.
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      ctx.waitUntil(
        logDelivery(env, {
          publicationId: null,
          method: request.method,
          path: url.pathname,
          status: 500,
          authUsed: auth.valid,
          validationOk: null,
          outcome: 'server_error',
          error: message,
          headers: request.headers,
          durationMs: Date.now() - startedAt,
        }).catch(() => null),
      );
      return problem(500, 'server_error', message);
    }
  },

  /**
   * Expiry is never notified by CaTH -- passing `displayTo` produces no
   * DELETE -- so content is aged out here.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const expired = await expirySweep(env);
        if (expired > 0) console.log(`expiry sweep: ${expired} publication(s) marked expired`);
      })(),
    );
  },
};
