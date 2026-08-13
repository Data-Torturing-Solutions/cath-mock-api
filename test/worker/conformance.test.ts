/**
 * The conformance suite: the CaTH API requirements, asserted clause by clause.
 *
 * This runs against the real Worker with real D1 and R2 bindings in workerd,
 * not against mocks. Green here is the evidence you take to onboarding.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import worker from '../../src/receiver/index.js';
import { generatePublication, Rng } from '../../src/shared/generator/index.js';
import { buildCathMultipart } from '../../src/shared/multipart.js';
import type { Env } from '../../src/receiver/env.js';
import type { PublicationRow } from '../../src/shared/types.js';

const BASE = 'https://cath.example/publications';

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

async function call(
  request: Request,
  overrides: Partial<Env> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, envWith(overrides), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function publicationRequest(
  publication: ReturnType<typeof generatePublication>,
  options: { method?: 'POST' | 'PUT'; url?: string } = {},
): Request {
  const method = options.method ?? 'POST';
  const url = options.url ?? (method === 'PUT' ? `${BASE}/${publication.metadata.publicationId}` : BASE);

  return new Request(url, {
    method,
    body: buildCathMultipart({
      metadata: publication.metadata,
      payload: publication.payload ?? undefined,
      file: publication.file
        ? { bytes: publication.file.bytes, name: publication.file.name, mime: publication.file.mime }
        : undefined,
    }),
  });
}

function rawRequest(
  body: FormData | string,
  options: { method?: string; url?: string; contentType?: string } = {},
): Request {
  return new Request(options.url ?? BASE, {
    method: options.method ?? 'POST',
    body,
    ...(options.contentType ? { headers: { 'content-type': options.contentType } } : {}),
  });
}

async function row(publicationId: string): Promise<PublicationRow | null> {
  return env.DB.prepare('SELECT * FROM publications WHERE publication_id = ?')
    .bind(publicationId)
    .first<PublicationRow>();
}

async function deliveriesFor(publicationId: string) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM deliveries WHERE publication_id = ? ORDER BY id',
  )
    .bind(publicationId)
    .all<{ status_sent: number; outcome: string; validation_ok: number | null; error: string | null }>();
  return results ?? [];
}

async function r2Keys(prefix: string): Promise<string[]> {
  const listed = await env.ARTEFACTS.list({ prefix });
  return listed.objects.map((o) => o.key).sort();
}

let counter = 0;
function seeded(overrides: Parameters<typeof generatePublication>[0] = {}) {
  counter += 1;
  return generatePublication({ rng: new Rng(`conformance-${counter}`), ...overrides });
}

describe('the four endpoints', () => {
  it('GET BaseURL returns 200 -- the connection test HMCTS run', async () => {
    const response = await call(new Request(BASE, { method: 'GET' }));
    expect(response.status).toBe(200);
  });

  it('GET BaseURL stays open even when AUTH_MODE is required', async () => {
    // HMCTS test the connection before auth is agreed; a 401 here blocks
    // onboarding for no security gain, since the response discloses nothing.
    const response = await call(new Request(BASE, { method: 'GET' }), { AUTH_MODE: 'required' });
    expect(response.status).toBe(200);
  });

  it('POST with valid metadata returns 200 with an empty body and creates a row', async () => {
    const publication = seeded({ artefact: 'json', sensitivity: 'PUBLIC' });
    const response = await call(publicationRequest(publication));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');

    const stored = await row(publication.metadata.publicationId);
    expect(stored).not.toBeNull();
    expect(stored!.version).toBe(1);
    expect(stored!.state).toBe('active');
    expect(stored!.list_type).toBe(publication.metadata.listType);
    expect(stored!.location_name).toBe(publication.metadata.locationName);
    expect(stored!.artefact_kind).toBe('json');
  });

  it('logs every request to deliveries', async () => {
    const publication = seeded({ artefact: 'json' });
    await call(publicationRequest(publication));

    const logged = await deliveriesFor(publication.metadata.publicationId);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.status_sent).toBe(200);
    expect(logged[0]!.outcome).toBe('created');
    expect(logged[0]!.validation_ok).toBe(1);
  });
});

describe('idempotency -- the same publication may arrive four times', () => {
  it('POST x4 identical leaves one row still at version 1', async () => {
    const publication = seeded({ artefact: 'json' });

    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await call(publicationRequest(publication));
      expect(response.status).toBe(200);
    }

    const { results } = await env.DB.prepare(
      'SELECT * FROM publications WHERE publication_id = ?',
    )
      .bind(publication.metadata.publicationId)
      .all<PublicationRow>();

    expect(results).toHaveLength(1);
    expect(results![0]!.version).toBe(1);

    // All four are still in the audit trail: one created, three unchanged.
    const logged = await deliveriesFor(publication.metadata.publicationId);
    expect(logged).toHaveLength(4);
    expect(logged.map((d) => d.outcome)).toEqual([
      'created',
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
  });

  it('DELETE x2 is idempotent', async () => {
    const publication = seeded({ artefact: 'json' });
    await call(publicationRequest(publication));

    const url = `${BASE}/${publication.metadata.publicationId}`;
    expect((await call(new Request(url, { method: 'DELETE' }))).status).toBe(200);
    expect((await call(new Request(url, { method: 'DELETE' }))).status).toBe(200);

    const outcomes = (await deliveriesFor(publication.metadata.publicationId)).map((d) => d.outcome);
    expect(outcomes).toContain('deleted');
    expect(outcomes).toContain('already_deleted');
  });
});

describe('supersede', () => {
  it('PUT on an existing id bumps the version and keeps both artefacts', async () => {
    const original = seeded({ artefact: 'json', size: 'minimal' });
    await call(publicationRequest(original));

    const replacement = generatePublication({
      rng: new Rng('supersede-replacement'),
      listType: original.metadata.listType,
      publicationId: original.metadata.publicationId,
      contentDate: new Date(original.metadata.contentDate),
      language: original.metadata.language,
      sensitivity: original.metadata.sensitivity,
      venue: original.venue,
      artefact: 'json',
      size: 'deep',
    });

    const response = await call(publicationRequest(replacement, { method: 'PUT' }));
    expect(response.status).toBe(200);

    const stored = await row(original.metadata.publicationId);
    expect(stored!.version).toBe(2);
    expect(stored!.state).toBe('active');

    // The superseded artefact survives -- we keep the history CaTH does not.
    const keys = await r2Keys(
      `${original.metadata.listType}/${original.metadata.contentDate.slice(0, 10)}/${original.metadata.publicationId}/`,
    );
    expect(keys).toContain(
      `${original.metadata.listType}/${original.metadata.contentDate.slice(0, 10)}/${original.metadata.publicationId}/v1.json`,
    );
    expect(keys).toContain(
      `${original.metadata.listType}/${original.metadata.contentDate.slice(0, 10)}/${original.metadata.publicationId}/v2.json`,
    );
  });

  it('PUT repeated with identical content does not bump the version', async () => {
    const publication = seeded({ artefact: 'json' });
    await call(publicationRequest(publication));
    await call(publicationRequest(publication, { method: 'PUT' }));
    await call(publicationRequest(publication, { method: 'PUT' }));

    expect((await row(publication.metadata.publicationId))!.version).toBe(1);
  });

  /**
   * The spec does not say what to do here, and HMCTS could not tell us whether
   * it happens (see the open questions in the README). We accept and create at
   * version 1, flagged `created_via = 'PUT'`. Rejecting would mean three
   * retries and then permanent loss of a publication.
   */
  it('PUT for an id we never received a POST for is accepted and flagged', async () => {
    const publication = seeded({ artefact: 'json' });
    const response = await call(publicationRequest(publication, { method: 'PUT' }));

    expect(response.status).toBe(200);
    const stored = await row(publication.metadata.publicationId);
    expect(stored!.version).toBe(1);
    expect(stored!.created_via).toBe('PUT');

    const logged = await deliveriesFor(publication.metadata.publicationId);
    expect(logged[0]!.outcome).toBe('created_via_put');
  });

  it('language is part of the supersede tuple: Welsh and English coexist', async () => {
    const contentDate = new Date('2026-03-04T00:00:00Z');
    const english = seeded({
      listType: 'CIVIL_DAILY_CAUSE_LIST',
      contentDate,
      language: 'ENGLISH',
      sensitivity: 'PUBLIC',
      artefact: 'json',
    });
    await call(publicationRequest(english));

    const others = ['WELSH', 'BI_LINGUAL'] as const;
    for (const language of others) {
      await call(
        publicationRequest(
          generatePublication({
            rng: new Rng(`welsh-${language}`),
            listType: 'CIVIL_DAILY_CAUSE_LIST',
            contentDate,
            venue: english.venue,
            language,
            sensitivity: 'PUBLIC',
            artefact: 'json',
          }),
        ),
      );
    }

    const { results } = await env.DB.prepare(
      `SELECT * FROM publications
        WHERE list_type = ? AND location_name = ? AND content_date = ? AND state = 'active'`,
    )
      .bind('CIVIL_DAILY_CAUSE_LIST', english.metadata.locationName, english.metadata.contentDate)
      .all<PublicationRow>();

    expect(results).toHaveLength(3);
    expect(new Set(results!.map((r) => r.language))).toEqual(
      new Set(['ENGLISH', 'WELSH', 'BI_LINGUAL']),
    );
  });
});

describe('delete', () => {
  it('soft-deletes and keeps the artefact', async () => {
    const publication = seeded({ artefact: 'json' });
    await call(publicationRequest(publication));
    const before = await row(publication.metadata.publicationId);

    const response = await call(
      new Request(`${BASE}/${publication.metadata.publicationId}`, { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);

    const after = await row(publication.metadata.publicationId);
    expect(after!.state).toBe('deleted');
    expect(after!.deleted_at).not.toBeNull();
    expect(after!.r2_key).toBe(before!.r2_key);
    expect(await env.ARTEFACTS.get(after!.r2_key!)).not.toBeNull();
  });

  it('returns 200 for an id we never held, and records why', async () => {
    const unknownId = new Rng('unknown-delete').uuid();
    const response = await call(new Request(`${BASE}/${unknownId}`, { method: 'DELETE' }));

    expect(response.status).toBe(200);
    const logged = await deliveriesFor(unknownId);
    expect(logged[0]!.outcome).toBe('delete_unknown');
  });
});

describe('flat-file publications', () => {
  it('stores a PDF and records its MIME type', async () => {
    const publication = seeded({ artefact: 'file' });
    // Force the PDF branch rather than relying on the mix.
    const pdf = generatePublication({
      rng: new Rng('pdf-fixture'),
      artefact: 'file',
      listType: 'CROWN_DAILY_PDDA_LIST',
      publicationId: publication.metadata.publicationId,
    });
    const forced = {
      ...pdf,
      file: {
        bytes: new TextEncoder().encode('%PDF-1.4\ntest fixture\n%%EOF\n'),
        name: `${pdf.metadata.publicationId}.pdf`,
        mime: 'application/pdf',
      },
    };

    const response = await call(publicationRequest(forced));
    expect(response.status).toBe(200);

    const stored = await row(forced.metadata.publicationId);
    expect(stored!.artefact_kind).toBe('file');
    expect(stored!.file_mime).toBe('application/pdf');
    expect(stored!.file_name).toBe(`${forced.metadata.publicationId}.pdf`);
    expect(stored!.r2_key!.endsWith('/v1.pdf')).toBe(true);

    const object = await env.ARTEFACTS.get(stored!.r2_key!);
    expect(object).not.toBeNull();
    expect(await object!.text()).toContain('%PDF-1.4');
  });

  it('accepts a metadata-only publication -- both other parts are optional', async () => {
    const publication = seeded({ artefact: 'json' });
    const response = await call(
      rawRequest(buildCathMultipart({ metadata: publication.metadata })),
    );

    expect(response.status).toBe(200);
    expect((await row(publication.metadata.publicationId))!.artefact_kind).toBe('none');
  });

  it('treats a literal null payload as absent, not as content', async () => {
    const publication = seeded({ artefact: 'json' });
    const form = new FormData();
    form.append(
      'metadata',
      new Blob([JSON.stringify(publication.metadata)], { type: 'application/json' }),
      'metadata.json',
    );
    form.append('payload', new Blob(['null'], { type: 'application/json' }), 'payload.json');

    await call(rawRequest(form));
    expect((await row(publication.metadata.publicationId))!.artefact_kind).toBe('none');
  });
});

describe('validation -- rejected, but never lost', () => {
  it('rejects a request with no metadata part and quarantines the body', async () => {
    const publication = seeded({ artefact: 'json' });
    const response = await call(
      rawRequest(
        buildCathMultipart({
          metadata: publication.metadata,
          payload: publication.payload ?? undefined,
          omitMetadata: true,
        }),
      ),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    const quarantined = await env.DB.prepare(
      `SELECT * FROM quarantine WHERE reason LIKE '%metadata%' ORDER BY id DESC LIMIT 1`,
    ).first<{ reason: string; r2_key: string | null }>();
    expect(quarantined).not.toBeNull();
    // The payload bytes survive the rejection.
    expect(quarantined!.r2_key).not.toBeNull();
  });

  it('rejects a bad enum value and says which field', async () => {
    const publication = seeded({ artefact: 'json' });
    const response = await call(
      rawRequest(
        buildCathMultipart({
          metadata: { ...publication.metadata, sensitivity: 'SECRET' },
          payload: publication.payload ?? undefined,
        }),
      ),
    );

    expect(response.status).toBe(422);
    const logged = await deliveriesFor(publication.metadata.publicationId);
    expect(logged[0]!.validation_ok).toBe(0);
    expect(logged[0]!.error).toContain('sensitivity');
    expect(await row(publication.metadata.publicationId)).toBeNull();
  });

  it('rejects a list type it has never heard of', async () => {
    const publication = seeded({ artefact: 'json' });
    const response = await call(
      rawRequest(
        buildCathMultipart({
          metadata: { ...publication.metadata, listType: 'SOME_NEW_LIST_HMCTS_ADDED' },
        }),
      ),
    );

    expect(response.status).toBe(422);
    const logged = await deliveriesFor(publication.metadata.publicationId);
    expect(logged[0]!.error).toContain('npm run refresh');
  });

  it('rejects a non-UUID publicationId', async () => {
    const publication = seeded({ artefact: 'json' });
    const response = await call(
      rawRequest(
        buildCathMultipart({ metadata: { ...publication.metadata, publicationId: 'not-a-uuid' } }),
      ),
    );
    expect(response.status).toBe(422);
  });

  it('rejects a body that is not multipart at all', async () => {
    const publication = seeded({ artefact: 'json' });
    const response = await call(
      rawRequest(JSON.stringify(publication.metadata), { contentType: 'application/json' }),
    );
    expect(response.status).toBe(400);
  });

  /**
   * displayTo before displayFrom is nonsense, but rejecting it would cost a
   * publication. It is warned about and stored.
   */
  it('accepts survivable oddities with a warning rather than rejecting', async () => {
    const publication = seeded({ artefact: 'json' });
    const response = await call(
      rawRequest(
        buildCathMultipart({
          metadata: {
            ...publication.metadata,
            displayFrom: publication.metadata.displayTo,
            displayTo: publication.metadata.displayFrom,
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    const logged = await deliveriesFor(publication.metadata.publicationId);
    expect(logged[0]!.error).toContain('displayTo is before displayFrom');
  });

  it('accepts an unexpected extra part and records it', async () => {
    const publication = seeded({ artefact: 'json' });
    const form = buildCathMultipart({ metadata: publication.metadata });
    form.append('signature', new Blob(['not-a-real-signature']), 'signature.txt');

    const response = await call(rawRequest(form));
    expect(response.status).toBe(200);

    const logged = await deliveriesFor(publication.metadata.publicationId);
    expect(logged[0]!.error).toContain('unexpected parts: signature');
  });

  it('VALIDATION_MODE=lenient accepts and quarantines instead of rejecting', async () => {
    const publication = seeded({ artefact: 'json' });
    const response = await call(
      rawRequest(
        buildCathMultipart({ metadata: { ...publication.metadata, language: 'CYMRAEG' } }),
      ),
      { VALIDATION_MODE: 'lenient' },
    );

    expect(response.status).toBe(200);
    const logged = await deliveriesFor(publication.metadata.publicationId);
    expect(logged[0]!.outcome).toBe('accepted_quarantined');
  });
});

describe('expiry -- never notified, so swept', () => {
  it('marks publications expired once displayTo has passed, with no DELETE', async () => {
    const publication = seeded({ artefact: 'json' });
    const past = new Date(Date.now() - 3 * 86_400_000);

    await call(
      rawRequest(
        buildCathMultipart({
          metadata: {
            ...publication.metadata,
            displayFrom: `${new Date(past.getTime() - 86_400_000).toISOString().slice(0, 19)}Z`,
            displayTo: `${past.toISOString().slice(0, 19)}Z`,
          },
        }),
      ),
    );

    expect((await row(publication.metadata.publicationId))!.state).toBe('active');

    const ctx = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: '7 * * * *', noRetry() {} } as ScheduledController,
      envWith(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const swept = await row(publication.metadata.publicationId);
    expect(swept!.state).toBe('expired');
    // Nothing was deleted, and CaTH never told us anything.
    expect(swept!.deleted_at).toBeNull();
    const outcomes = (await deliveriesFor(publication.metadata.publicationId)).map((d) => d.outcome);
    expect(outcomes).not.toContain('deleted');
  });

  it('leaves publications that are still displayable alone', async () => {
    const publication = seeded({ artefact: 'json', displayDurationDays: 30 });
    await call(publicationRequest(publication));

    const ctx = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: '7 * * * *', noRetry() {} } as ScheduledController,
      envWith(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect((await row(publication.metadata.publicationId))!.state).toBe('active');
  });
});

describe('routing', () => {
  it('404s anything outside the base path', async () => {
    const response = await call(new Request('https://cath.example/elsewhere', { method: 'POST' }));
    expect(response.status).toBe(404);
  });

  it('405s a method the contract does not define', async () => {
    const response = await call(new Request(BASE, { method: 'PATCH' }));
    expect(response.status).toBe(405);
  });

  it('honours a BASE_PATH change', async () => {
    const response = await call(
      new Request('https://cath.example/cath/inbound', { method: 'GET' }),
      { BASE_PATH: '/cath/inbound' },
    );
    expect(response.status).toBe(200);
  });

  it('trusts the path id over the metadata id on a PUT, and says so', async () => {
    const publication = seeded({ artefact: 'json' });
    const pathId = new Rng('mismatch').uuid();

    const response = await call(
      publicationRequest(publication, { method: 'PUT', url: `${BASE}/${pathId}` }),
    );
    expect(response.status).toBe(200);

    expect(await row(pathId)).not.toBeNull();
    const logged = await deliveriesFor(pathId);
    expect(logged[0]!.error).toContain('does not match metadata publicationId');
  });
});

describe('audit trail', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM deliveries').run();
  });

  it('records a health check without a publication id', async () => {
    await call(new Request(BASE, { method: 'GET' }));

    const { results } = await env.DB.prepare(
      `SELECT * FROM deliveries WHERE outcome = 'health_check'`,
    ).all<{ publication_id: string | null; method: string }>();

    expect(results!.length).toBeGreaterThan(0);
    expect(results![0]!.publication_id).toBeNull();
    expect(results![0]!.method).toBe('GET');
  });

  it('never records the Authorization header value', async () => {
    const publication = seeded({ artefact: 'json' });
    const request = publicationRequest(publication);
    request.headers.set('authorization', 'Bearer super-secret-token-value');

    await call(request);

    const logged = await env.DB.prepare(
      'SELECT raw_headers FROM deliveries ORDER BY id DESC LIMIT 1',
    ).first<{ raw_headers: string }>();

    expect(logged!.raw_headers).toContain('redacted');
    expect(logged!.raw_headers).not.toContain('super-secret-token-value');
  });
});
