/**
 * Auth, including the two things that are easy to get wrong: AUTH_MODE must
 * fail closed, and read paths must be gated by sensitivity regardless of what
 * AUTH_MODE says.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import worker from '../../src/receiver/index.js';
import { generatePublication, Rng } from '../../src/shared/generator/index.js';
import { buildCathMultipart } from '../../src/shared/multipart.js';
import type { Env } from '../../src/receiver/env.js';

const ORIGIN = 'https://cath.example';
const BASE = `${ORIGIN}/publications`;

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

async function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, envWith(overrides), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function getToken(overrides: Partial<Env> = {}): Promise<string> {
  const response = await call(
    new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'hmcts-cath',
        client_secret: 'test-client-secret',
        scope: 'cath.publish',
      }),
    }),
    overrides,
  );
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

let counter = 0;
function postRequest(token?: string) {
  counter += 1;
  const publication = generatePublication({
    rng: new Rng(`auth-${counter}`),
    artefact: 'json',
    size: 'minimal',
  });
  const request = new Request(BASE, {
    method: 'POST',
    body: buildCathMultipart({
      metadata: publication.metadata,
      payload: publication.payload ?? undefined,
    }),
  });
  if (token) request.headers.set('authorization', `Bearer ${token}`);
  return { request, publication };
}

describe('token endpoint', () => {
  it('issues a bearer token for valid client credentials', async () => {
    const response = await call(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'hmcts-cath',
          client_secret: 'test-client-secret',
          scope: 'cath.publish',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['token_type']).toBe('Bearer');
    expect(body['expires_in']).toBe(3600);
    expect(body['scope']).toBe('cath.publish');
    expect(String(body['access_token']).split('.')).toHaveLength(3);
  });

  it('accepts HTTP Basic client authentication too', async () => {
    const response = await call(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${btoa('hmcts-cath:test-client-secret')}`,
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it('rejects a wrong secret with invalid_client', async () => {
    const response = await call(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'hmcts-cath',
          client_secret: 'wrong',
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect((await response.json() as { error: string }).error).toBe('invalid_client');
  });

  it('rejects an unsupported grant type', async () => {
    const response = await call(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password' }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('unsupported_grant_type');
  });

  it('rejects a scope it does not grant', async () => {
    const response = await call(
      new Request(`${ORIGIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'hmcts-cath',
          client_secret: 'test-client-secret',
          scope: 'admin.everything',
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_scope');
  });
});

describe('AUTH_MODE matrix', () => {
  const cases: Array<{
    mode: Partial<Env>;
    label: string;
    noToken: number;
    badToken: number;
    goodToken: number;
  }> = [
    { mode: { AUTH_MODE: 'off' }, label: 'off', noToken: 200, badToken: 200, goodToken: 200 },
    { mode: { AUTH_MODE: 'optional' }, label: 'optional', noToken: 200, badToken: 200, goodToken: 200 },
    { mode: { AUTH_MODE: 'required' }, label: 'required', noToken: 401, badToken: 401, goodToken: 200 },
    // Fail closed: an unset or misspelled value must behave as `required`.
    { mode: { AUTH_MODE: undefined }, label: 'unset', noToken: 401, badToken: 401, goodToken: 200 },
    { mode: { AUTH_MODE: 'Required' }, label: 'typo', noToken: 401, badToken: 401, goodToken: 200 },
    { mode: { AUTH_MODE: 'none' }, label: 'plausible-but-wrong', noToken: 401, badToken: 401, goodToken: 200 },
  ];

  for (const testCase of cases) {
    it(`AUTH_MODE=${testCase.label}`, async () => {
      const good = await getToken();

      const withoutToken = await call(postRequest().request, testCase.mode);
      expect(withoutToken.status, 'no token').toBe(testCase.noToken);

      const withBadToken = await call(postRequest('not.a.jwt').request, testCase.mode);
      expect(withBadToken.status, 'bad token').toBe(testCase.badToken);

      const withGoodToken = await call(postRequest(good).request, testCase.mode);
      expect(withGoodToken.status, 'good token').toBe(testCase.goodToken);
    });
  }

  it('records which path was used, so a live feed is distinguishable from the simulator', async () => {
    const token = await getToken();

    const authed = postRequest(token);
    await call(authed.request, { AUTH_MODE: 'optional' });
    const anonymous = postRequest();
    await call(anonymous.request, { AUTH_MODE: 'optional' });

    const authedRow = await env.DB.prepare(
      'SELECT auth_used FROM publications WHERE publication_id = ?',
    )
      .bind(authed.publication.metadata.publicationId)
      .first<{ auth_used: number }>();
    const anonymousRow = await env.DB.prepare(
      'SELECT auth_used FROM publications WHERE publication_id = ?',
    )
      .bind(anonymous.publication.metadata.publicationId)
      .first<{ auth_used: number }>();

    expect(authedRow!.auth_used).toBe(1);
    expect(anonymousRow!.auth_used).toBe(0);
  });

  it('rejects a token signed with the wrong key', async () => {
    const foreign = await getToken({ JWT_SIGNING_KEY: 'a-different-signing-key' });
    const response = await call(postRequest(foreign).request, { AUTH_MODE: 'required' });
    expect(response.status).toBe(401);
  });

  it('rejects a token for the wrong audience', async () => {
    const foreign = await getToken({ JWT_AUDIENCE: 'some-other-service' });
    const response = await call(postRequest(foreign).request, { AUTH_MODE: 'required' });
    expect(response.status).toBe(401);
  });

  it('sends WWW-Authenticate when it rejects', async () => {
    const response = await call(postRequest().request, { AUTH_MODE: 'required' });
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('logs the rejection rather than dropping it silently', async () => {
    const { publication } = postRequest();
    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM deliveries WHERE outcome = 'rejected_unauthorized'`,
    ).first<{ n: number }>();

    await call(postRequest().request, { AUTH_MODE: 'required' });

    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM deliveries WHERE outcome = 'rejected_unauthorized'`,
    ).first<{ n: number }>();

    expect(after!.n).toBe(before!.n + 1);
    expect(publication).toBeDefined();
  });
});

/**
 * The gating that has to be right before any real data arrives: with mock data
 * an open read path is harmless, but the moment a live CaTH feed points here
 * it is an open-justice breach.
 */
describe('sensitivity gating on reads, independent of AUTH_MODE', () => {
  async function seed(sensitivity: 'PUBLIC' | 'PRIVATE' | 'CLASSIFIED') {
    counter += 1;
    const publication = generatePublication({
      rng: new Rng(`sensitivity-${sensitivity}-${counter}`),
      artefact: 'json',
      size: 'minimal',
      sensitivity,
    });
    await call(
      new Request(BASE, {
        method: 'POST',
        body: buildCathMultipart({
          metadata: publication.metadata,
          payload: publication.payload ?? undefined,
        }),
      }),
      { AUTH_MODE: 'off' },
    );
    return publication;
  }

  it('hides PRIVATE and CLASSIFIED from an anonymous reader even with AUTH_MODE=off', async () => {
    const priv = await seed('PRIVATE');
    const classified = await seed('CLASSIFIED');
    const open = await seed('PUBLIC');

    const response = await call(
      new Request(`${ORIGIN}/admin/publications?limit=500`),
      { AUTH_MODE: 'off' },
    );
    const body = (await response.json()) as { publications: Array<{ publication_id: string; sensitivity: string }> };

    const ids = body.publications.map((p) => p.publication_id);
    expect(ids).toContain(open.metadata.publicationId);
    expect(ids).not.toContain(priv.metadata.publicationId);
    expect(ids).not.toContain(classified.metadata.publicationId);
    expect(new Set(body.publications.map((p) => p.sensitivity))).toEqual(new Set(['PUBLIC']));
  });

  it('404s a single non-public publication rather than confirming it exists', async () => {
    const priv = await seed('PRIVATE');
    const response = await call(
      new Request(`${ORIGIN}/admin/publications/${priv.metadata.publicationId}`),
      { AUTH_MODE: 'off' },
    );
    expect(response.status).toBe(404);
  });

  it('refuses to serve a non-public artefact to an anonymous reader', async () => {
    const priv = await seed('CLASSIFIED');
    const response = await call(
      new Request(`${ORIGIN}/admin/publications/${priv.metadata.publicationId}/artefact`),
      { AUTH_MODE: 'off' },
    );
    expect(response.status).toBe(404);
  });

  it('serves them to a valid bearer', async () => {
    const priv = await seed('PRIVATE');
    const token = await getToken();

    const request = new Request(`${ORIGIN}/admin/publications/${priv.metadata.publicationId}`);
    request.headers.set('authorization', `Bearer ${token}`);

    const response = await call(request, { AUTH_MODE: 'off' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { publication: { sensitivity: string } };
    expect(body.publication.sensitivity).toBe('PRIVATE');
  });

  it('serves them to the admin token', async () => {
    const priv = await seed('CLASSIFIED');
    const request = new Request(`${ORIGIN}/admin/publications/${priv.metadata.publicationId}`);
    request.headers.set('x-admin-token', 'test-admin-token');

    const response = await call(request, { AUTH_MODE: 'off' });
    expect(response.status).toBe(200);
  });

  it('keeps quarantine behind auth entirely', async () => {
    const anonymous = await call(new Request(`${ORIGIN}/admin/quarantine`), { AUTH_MODE: 'off' });
    expect(anonymous.status).toBe(403);

    const request = new Request(`${ORIGIN}/admin/quarantine`);
    request.headers.set('x-admin-token', 'test-admin-token');
    expect((await call(request, { AUTH_MODE: 'off' })).status).toBe(200);
  });
});
