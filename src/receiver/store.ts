/**
 * Publication storage: D1 for queryable metadata, R2 for blobs.
 *
 * Two rules drive everything here:
 *   - `publicationId` is the key. CaTH's real supersede rule uses provenance
 *     and location ID, neither of which reach us, so we do not pretend to
 *     reimplement it -- we record the tuple we can see and key on the UUID.
 *   - The same publication may legitimately arrive four times (one push plus
 *     three retries), so every path is idempotent on content hash.
 */
import { contentHash } from '../shared/hash.js';
import { extensionFor } from '../shared/multipart.js';
import type { ArtefactKind, PublicationMetadata, PublicationRow } from '../shared/types.js';
import type { Env } from './env.js';

export type Outcome =
  | 'created'
  | 'created_via_put'
  | 'unchanged'
  | 'superseded'
  | 'revived'
  | 'deleted'
  | 'already_deleted'
  | 'delete_unknown';

export interface StoreInput {
  metadata: PublicationMetadata;
  payloadText: string | null;
  fileBytes: ArrayBuffer | null;
  fileName: string | null;
  fileMime: string | null;
  method: 'POST' | 'PUT';
  authUsed: boolean;
}

export interface StoreResult {
  outcome: Outcome;
  version: number;
  r2Key: string | null;
}

function dateOnly(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed)
    ? 'unknown-date'
    : (new Date(parsed).toISOString().slice(0, 10) as string);
}

/**
 * Versioned keys, so a supersede never destroys what it replaced. Keeping the
 * history is the whole reason to store artefacts ourselves -- CaTH does not.
 */
export function artefactKey(
  metadata: PublicationMetadata,
  version: number,
  extension: string,
): string {
  return `${metadata.listType}/${dateOnly(metadata.contentDate)}/${metadata.publicationId}/v${version}.${extension}`;
}

async function putArtefacts(
  env: Env,
  metadata: PublicationMetadata,
  version: number,
  input: StoreInput,
): Promise<{ key: string | null; kind: ArtefactKind }> {
  // Metadata is always written alongside the artefact: it is the evidence that
  // we received exactly what CaTH says it sent.
  await env.ARTEFACTS.put(
    artefactKey(metadata, version, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    { httpMetadata: { contentType: 'application/json' } },
  );

  if (input.fileBytes) {
    const extension = extensionFor(input.fileName, input.fileMime);
    const key = artefactKey(metadata, version, extension);
    await env.ARTEFACTS.put(key, input.fileBytes, {
      httpMetadata: { contentType: input.fileMime ?? 'application/octet-stream' },
      customMetadata: { originalFileName: input.fileName ?? '' },
    });
    // A publication can carry both parts; keep the JSON too rather than lose it.
    if (input.payloadText) {
      await env.ARTEFACTS.put(artefactKey(metadata, version, 'json'), input.payloadText, {
        httpMetadata: { contentType: 'application/json' },
      });
    }
    return { key, kind: 'file' };
  }

  if (input.payloadText) {
    const key = artefactKey(metadata, version, 'json');
    await env.ARTEFACTS.put(key, input.payloadText, {
      httpMetadata: { contentType: 'application/json' },
    });
    return { key, kind: 'json' };
  }

  return { key: null, kind: 'none' };
}

export async function getPublication(env: Env, id: string): Promise<PublicationRow | null> {
  return env.DB.prepare('SELECT * FROM publications WHERE publication_id = ?')
    .bind(id)
    .first<PublicationRow>();
}

export async function storePublication(env: Env, input: StoreInput): Promise<StoreResult> {
  const { metadata } = input;
  const now = new Date().toISOString();
  const hash = await contentHash({
    metadata: metadata as Record<string, unknown>,
    payloadText: input.payloadText,
    fileBytes: input.fileBytes,
  });

  const existing = await getPublication(env, metadata.publicationId);
  const authUsed = input.authUsed ? 1 : 0;

  if (!existing) {
    const version = 1;
    const { key, kind } = await putArtefacts(env, metadata, version, input);

    await env.DB.prepare(
      `INSERT INTO publications (
         publication_id, list_type, location_name, content_date, sensitivity, language,
         display_from, display_to, artefact_kind, r2_key, file_mime, file_name,
         content_hash, version, state, created_via, first_seen_at, last_seen_at, auth_used
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
      .bind(
        metadata.publicationId,
        metadata.listType,
        metadata.locationName,
        metadata.contentDate,
        metadata.sensitivity,
        metadata.language,
        metadata.displayFrom,
        metadata.displayTo,
        kind,
        key,
        input.fileMime,
        input.fileName,
        hash,
        version,
        input.method,
        now,
        now,
        authUsed,
      )
      .run();

    return {
      outcome: input.method === 'PUT' ? 'created_via_put' : 'created',
      version,
      r2Key: key,
    };
  }

  // Identical content: a retry, or CaTH re-sending what we already hold.
  if (existing.content_hash === hash) {
    const revived = existing.state !== 'active';
    await env.DB.prepare(
      `UPDATE publications
          SET last_seen_at = ?, auth_used = ?, state = 'active',
              deleted_at = CASE WHEN ? = 1 THEN NULL ELSE deleted_at END
        WHERE publication_id = ?`,
    )
      .bind(now, authUsed, revived ? 1 : 0, metadata.publicationId)
      .run();

    return {
      outcome: revived ? 'revived' : 'unchanged',
      version: existing.version,
      r2Key: existing.r2_key,
    };
  }

  // Content changed: this supersedes what we hold. Both artefacts are kept.
  const version = existing.version + 1;
  const { key, kind } = await putArtefacts(env, metadata, version, input);

  await env.DB.prepare(
    `UPDATE publications
        SET list_type = ?, location_name = ?, content_date = ?, sensitivity = ?, language = ?,
            display_from = ?, display_to = ?, artefact_kind = ?, r2_key = ?, file_mime = ?,
            file_name = ?, content_hash = ?, version = ?, state = 'active', deleted_at = NULL,
            last_seen_at = ?, auth_used = ?
      WHERE publication_id = ?`,
  )
    .bind(
      metadata.listType,
      metadata.locationName,
      metadata.contentDate,
      metadata.sensitivity,
      metadata.language,
      metadata.displayFrom,
      metadata.displayTo,
      kind,
      key,
      input.fileMime,
      input.fileName,
      hash,
      version,
      now,
      authUsed,
      metadata.publicationId,
    )
    .run();

  return { outcome: 'superseded', version, r2Key: key };
}

/**
 * DELETE means "manually deleted in CaTH", not expiry. The artefact is kept:
 * we hold the history CaTH does not.
 */
export async function softDelete(
  env: Env,
  publicationId: string,
  authUsed: boolean,
): Promise<{ outcome: Outcome }> {
  const existing = await getPublication(env, publicationId);
  if (!existing) return { outcome: 'delete_unknown' };
  if (existing.state === 'deleted') return { outcome: 'already_deleted' };

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE publications
        SET state = 'deleted', deleted_at = ?, last_seen_at = ?, auth_used = ?
      WHERE publication_id = ?`,
  )
    .bind(now, now, authUsed ? 1 : 0, publicationId)
    .run();

  return { outcome: 'deleted' };
}

/**
 * Expiry is never notified -- passing `displayTo` produces no DELETE -- so we
 * age content out ourselves on a cron.
 */
export async function expirySweep(env: Env, now = new Date()): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE publications
        SET state = 'expired'
      WHERE state = 'active' AND display_to < ?`,
  )
    .bind(now.toISOString())
    .run();

  return result.meta.changes ?? 0;
}

/** The supersede tuple we can actually see, for the secondary index. */
export async function findBySupersedeTuple(
  env: Env,
  metadata: PublicationMetadata,
): Promise<PublicationRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM publications
      WHERE list_type = ? AND location_name = ? AND language = ? AND content_date = ?
        AND state = 'active'`,
  )
    .bind(metadata.listType, metadata.locationName, metadata.language, metadata.contentDate)
    .all<PublicationRow>();

  return results ?? [];
}
