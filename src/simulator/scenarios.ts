/**
 * The scenarios: what CaTH actually does to you, including the awkward parts.
 */
import { generatePublication, Rng, type GeneratedPublication } from '../shared/generator/index.js';
import { buildCathMultipart } from '../shared/multipart.js';
import type { PublicationRow } from '../shared/types.js';
import { buildChaosRequest, pickChaos, type ChaosKind } from './chaos.js';
import { deliver, type DeliveryResult } from './deliver.js';
import { chaosRate, dailyVolume, receiverOrigin, receiverUrl, type SimulatorEnv } from './env.js';

export type ScenarioName =
  | 'daily'
  | 'supersede'
  | 'delete'
  | 'flat_files'
  | 'future_dated'
  | 'welsh'
  | 'retry_proof'
  | 'chaos'
  | 'health';

export interface ScenarioReport {
  scenario: ScenarioName;
  seed: string;
  deliveries: DeliveryResult[];
  notes: string[];
}

interface RunContext {
  env: SimulatorEnv;
  rng: Rng;
  token: string | null;
  seed: string;
}

function push(
  ctx: RunContext,
  publication: GeneratedPublication,
  method: 'POST' | 'PUT' = 'POST',
): Promise<DeliveryResult> {
  const base = receiverUrl(ctx.env);
  const url = method === 'PUT' ? `${base}/${publication.metadata.publicationId}` : base;

  return deliver(ctx.env, {
    method,
    url,
    publicationId: publication.metadata.publicationId,
    token: ctx.token,
    body: buildCathMultipart({
      metadata: publication.metadata,
      payload: publication.payload ?? undefined,
      file: publication.file
        ? {
          bytes: publication.file.bytes,
          name: publication.file.name,
          mime: publication.file.mime,
        }
        : undefined,
    }),
  });
}

/** Reads back what the receiver holds, so supersedes and deletes hit real rows. */
async function activePublications(ctx: RunContext, limit: number): Promise<PublicationRow[]> {
  const url = `${receiverOrigin(ctx.env)}/admin/publications?state=active&limit=${limit}`;
  const headers: Record<string, string> = {};
  if (ctx.token) headers['authorization'] = `Bearer ${ctx.token}`;
  if (ctx.env.SIM_ADMIN_TOKEN) headers['x-admin-token'] = ctx.env.SIM_ADMIN_TOKEN;

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return [];
    const body = (await response.json()) as { publications?: PublicationRow[] };
    return body.publications ?? [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ daily */

async function daily(ctx: RunContext, count: number): Promise<ScenarioReport> {
  const deliveries: DeliveryResult[] = [];
  const rate = chaosRate(ctx.env);
  const notes: string[] = [];

  for (let i = 0; i < count; i++) {
    const publication = generatePublication({
      rng: ctx.rng,
      size: ctx.rng.weighted([['minimal', 10], ['typical', 80], ['deep', 10]]),
    });

    if (rate > 0 && ctx.rng.chance(rate)) {
      deliveries.push(await pushChaos(ctx, publication, pickChaos(ctx.rng)));
      continue;
    }

    deliveries.push(await push(ctx, publication));
  }

  notes.push(`${count} publications at a ${(rate * 100).toFixed(0)}% chaos rate`);
  return { scenario: 'daily', seed: ctx.seed, deliveries, notes };
}

/* -------------------------------------------------------------- supersede */

/**
 * A vacated hearing, republished. CaTH decides supersession on provenance,
 * type, location ID, language and content date -- two of which never reach us
 * -- so the simulator does the only thing a receiver can rely on: PUT the same
 * publicationId with different content.
 */
async function supersede(ctx: RunContext, count: number): Promise<ScenarioReport> {
  const existing = await activePublications(ctx, Math.max(count * 3, 30));
  const deliveries: DeliveryResult[] = [];
  const notes: string[] = [];

  if (existing.length === 0) {
    notes.push('nothing active to supersede; seeding one first');
    const seeded = generatePublication({ rng: ctx.rng, artefact: 'json' });
    deliveries.push(await push(ctx, seeded));
    deliveries.push(
      await push(
        ctx,
        generatePublication({
          rng: ctx.rng,
          artefact: 'json',
          listType: seeded.metadata.listType,
          publicationId: seeded.metadata.publicationId,
          venue: seeded.venue,
          contentDate: new Date(seeded.metadata.contentDate),
          language: seeded.metadata.language,
          sensitivity: seeded.metadata.sensitivity,
        }),
        'PUT',
      ),
    );
    return { scenario: 'supersede', seed: ctx.seed, deliveries, notes };
  }

  for (const row of ctx.rng.shuffle(existing).slice(0, count)) {
    // Same key fields, new content: this is what a republished list looks like.
    const replacement = generatePublication({
      rng: ctx.rng,
      listType: row.list_type,
      publicationId: row.publication_id,
      contentDate: new Date(row.content_date),
      language: row.language,
      sensitivity: row.sensitivity,
      artefact: row.artefact_kind === 'file' ? 'file' : 'json',
    });
    deliveries.push(await push(ctx, replacement, 'PUT'));
  }

  notes.push(`superseded ${deliveries.length} of ${existing.length} active publications`);
  return { scenario: 'supersede', seed: ctx.seed, deliveries, notes };
}

/* ----------------------------------------------------------------- delete */

async function remove(ctx: RunContext, count: number): Promise<ScenarioReport> {
  const existing = await activePublications(ctx, Math.max(count * 3, 30));
  const deliveries: DeliveryResult[] = [];
  const base = receiverUrl(ctx.env);

  for (const row of ctx.rng.shuffle(existing).slice(0, count)) {
    deliveries.push(
      await deliver(ctx.env, {
        method: 'DELETE',
        url: `${base}/${row.publication_id}`,
        publicationId: row.publication_id,
        token: ctx.token,
      }),
    );
  }

  // CaTH will happily delete something you never received.
  const unknownId = ctx.rng.uuid();
  deliveries.push(
    await deliver(ctx.env, {
      method: 'DELETE',
      url: `${base}/${unknownId}`,
      publicationId: unknownId,
      token: ctx.token,
    }),
  );

  return {
    scenario: 'delete',
    seed: ctx.seed,
    deliveries,
    notes: ['the final delete is for an id the receiver has never seen'],
  };
}

/* ------------------------------------------------------------- flat files */

async function flatFiles(ctx: RunContext, count: number): Promise<ScenarioReport> {
  const deliveries: DeliveryResult[] = [];
  for (let i = 0; i < count; i++) {
    deliveries.push(await push(ctx, generatePublication({ rng: ctx.rng, artefact: 'file' })));
  }
  return {
    scenario: 'flat_files',
    seed: ctx.seed,
    deliveries,
    notes: ['pdf, csv and html, each with a null payload part'],
  };
}

/* ----------------------------------------------------------- future dated */

/**
 * Publications with a future displayFrom are not sent when they are created --
 * they arrive at 1AM UTC on the first morning they are active. From the
 * receiver's side that means a burst of same-day publications in the small
 * hours, which is what this pushes.
 */
async function futureDated(ctx: RunContext, count: number): Promise<ScenarioReport> {
  const deliveries: DeliveryResult[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < count; i++) {
    deliveries.push(
      await push(
        ctx,
        generatePublication({
          rng: ctx.rng,
          contentDate: today,
          displayFromOffsetDays: 0,
          displayDurationDays: ctx.rng.int(1, 5),
        }),
      ),
    );
  }

  return {
    scenario: 'future_dated',
    seed: ctx.seed,
    deliveries,
    notes: ['created days ago, released now -- the 1AM UTC burst'],
  };
}

/* ------------------------------------------------------------------ welsh */

/**
 * A Welsh, an English and a bilingual publication sharing list type, location
 * and content date. They differ only by language, so none of them supersedes
 * another: three live rows, not one.
 */
async function welsh(ctx: RunContext): Promise<ScenarioReport> {
  const deliveries: DeliveryResult[] = [];
  const contentDate = new Date();
  contentDate.setUTCHours(0, 0, 0, 0);

  const first = generatePublication({
    rng: ctx.rng,
    listType: 'CIVIL_DAILY_CAUSE_LIST',
    contentDate,
    language: 'ENGLISH',
    sensitivity: 'PUBLIC',
    artefact: 'json',
  });
  deliveries.push(await push(ctx, first));

  for (const language of ['WELSH', 'BI_LINGUAL'] as const) {
    deliveries.push(
      await push(
        ctx,
        generatePublication({
          rng: ctx.rng,
          listType: 'CIVIL_DAILY_CAUSE_LIST',
          contentDate,
          venue: first.venue,
          language,
          sensitivity: 'PUBLIC',
          artefact: 'json',
        }),
      ),
    );
  }

  return {
    scenario: 'welsh',
    seed: ctx.seed,
    deliveries,
    notes: [
      `three languages at ${first.venue.name} on ${contentDate.toISOString().slice(0, 10)}`,
      'all three must remain active -- language is part of the supersede tuple',
    ],
  };
}

/* ------------------------------------------------------------ retry proof */

/**
 * The same publication four times, as CaTH would after a non-2xx. Proves
 * idempotency rather than assuming it.
 */
async function retryProof(ctx: RunContext): Promise<ScenarioReport> {
  const publication = generatePublication({ rng: ctx.rng, artefact: 'json', size: 'typical' });
  const deliveries: DeliveryResult[] = [];

  for (let attempt = 1; attempt <= 4; attempt++) {
    deliveries.push(await push(ctx, publication));
  }

  return {
    scenario: 'retry_proof',
    seed: ctx.seed,
    deliveries,
    notes: [
      `publicationId ${publication.metadata.publicationId} pushed 4 times`,
      'the receiver must hold one row at version 1',
    ],
  };
}

/* ------------------------------------------------------------------ chaos */

async function pushChaos(
  ctx: RunContext,
  publication: GeneratedPublication,
  kind: ChaosKind,
): Promise<DeliveryResult> {
  const request = buildChaosRequest(kind, publication, ctx.rng);
  const result = await deliver(ctx.env, {
    method: 'POST',
    url: receiverUrl(ctx.env),
    publicationId: publication.metadata.publicationId,
    token: ctx.token,
    body: request.body,
    contentType: typeof request.body === 'string' ? request.contentType : undefined,
    // A push we expect to be rejected still gets CaTH's three retries.
    retryCount: request.expected === 'reject' ? 3 : 0,
  });
  return { ...result, method: `POST (chaos: ${kind})` };
}

async function chaos(ctx: RunContext, count: number): Promise<ScenarioReport> {
  const deliveries: DeliveryResult[] = [];
  for (let i = 0; i < count; i++) {
    const publication = generatePublication({ rng: ctx.rng, artefact: 'json', size: 'minimal' });
    deliveries.push(await pushChaos(ctx, publication, pickChaos(ctx.rng)));
  }
  return {
    scenario: 'chaos',
    seed: ctx.seed,
    deliveries,
    notes: ['every rejected push is retried 3 more times, as CaTH would'],
  };
}

/* ----------------------------------------------------------------- health */

async function health(ctx: RunContext): Promise<ScenarioReport> {
  return {
    scenario: 'health',
    seed: ctx.seed,
    deliveries: [
      await deliver(ctx.env, {
        method: 'GET',
        url: receiverUrl(ctx.env),
        token: ctx.token,
        retryCount: 0,
      }),
    ],
    notes: ['the connection test HMCTS run before onboarding'],
  };
}

/* --------------------------------------------------------------- dispatch */

export async function runScenario(
  env: SimulatorEnv,
  scenario: ScenarioName,
  options: { seed?: string; count?: number; token?: string | null } = {},
): Promise<ScenarioReport> {
  const seed = options.seed ?? `sim-${Date.now()}`;
  const ctx: RunContext = { env, rng: new Rng(seed), token: options.token ?? null, seed };
  const count = options.count ?? dailyVolume(env);

  switch (scenario) {
    case 'daily':
      return daily(ctx, count);
    case 'supersede':
      return supersede(ctx, Math.min(count, 25));
    case 'delete':
      return remove(ctx, Math.min(count, 10));
    case 'flat_files':
      return flatFiles(ctx, Math.min(count, 10));
    case 'future_dated':
      return futureDated(ctx, Math.min(count, 25));
    case 'welsh':
      return welsh(ctx);
    case 'retry_proof':
      return retryProof(ctx);
    case 'chaos':
      return chaos(ctx, Math.min(count, 15));
    case 'health':
    default:
      return health(ctx);
  }
}
