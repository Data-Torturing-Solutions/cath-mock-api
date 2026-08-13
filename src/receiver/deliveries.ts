/**
 * The audit trail. Every request is logged, including retries, rejects and
 * unauthenticated attempts -- this table is the evidence that the endpoint did
 * not drop a publication, which is the only thing HMCTS actually care about.
 */
import type { Env } from './env.js';

export interface DeliveryLog {
  publicationId: string | null;
  method: string;
  path: string;
  status: number;
  authUsed: boolean;
  validationOk: boolean | null;
  outcome: string | null;
  error: string | null;
  headers: Headers;
  durationMs: number;
}

/** Header allowlist -- never log Authorization or Cookie. */
const LOGGED_HEADERS = [
  'content-type',
  'content-length',
  'user-agent',
  'x-request-id',
  'x-correlation-id',
  'cf-ray',
  'cf-connecting-ip',
  'traceparent',
];

function safeHeaders(headers: Headers): string {
  const captured: Record<string, string> = {};
  for (const name of LOGGED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) captured[name] = value;
  }
  // Record that a credential was presented without recording the credential.
  const auth = headers.get('authorization');
  if (auth) captured['authorization'] = `${auth.split(/\s+/)[0] ?? 'unknown'} <redacted>`;
  return JSON.stringify(captured);
}

export async function logDelivery(env: Env, entry: DeliveryLog): Promise<number | null> {
  const result = await env.DB.prepare(
    `INSERT INTO deliveries (
       publication_id, method, path, received_at, status_sent, auth_used,
       validation_ok, outcome, error, raw_headers, duration_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.publicationId,
      entry.method,
      entry.path,
      new Date().toISOString(),
      entry.status,
      entry.authUsed ? 1 : 0,
      entry.validationOk === null ? null : entry.validationOk ? 1 : 0,
      entry.outcome,
      entry.error,
      safeHeaders(entry.headers),
      entry.durationMs,
    )
    .run();

  return (result.meta.last_row_id as number | undefined) ?? null;
}

export interface QuarantineEntry {
  deliveryId: number | null;
  publicationId: string | null;
  reason: string;
  metadataText: string | null;
  payloadText: string | null;
  fileBytes: ArrayBuffer | null;
  fileName: string | null;
}

/**
 * A publication we returned a 4xx for is retried three times and then gone
 * forever. We keep the bytes regardless of the status we sent, so a validation
 * bug is recoverable rather than terminal.
 */
export async function quarantine(env: Env, entry: QuarantineEntry): Promise<void> {
  const receivedAt = new Date().toISOString();
  let r2Key: string | null = null;

  if (entry.payloadText || entry.fileBytes) {
    const id = entry.publicationId ?? `unidentified-${crypto.randomUUID()}`;
    r2Key = `_quarantine/${receivedAt.slice(0, 10)}/${id}/${receivedAt.replace(/[:.]/g, '-')}`;

    if (entry.fileBytes) {
      await env.ARTEFACTS.put(`${r2Key}/file`, entry.fileBytes, {
        customMetadata: { originalFileName: entry.fileName ?? '', reason: entry.reason },
      });
    }
    if (entry.payloadText) {
      await env.ARTEFACTS.put(`${r2Key}/payload.json`, entry.payloadText, {
        httpMetadata: { contentType: 'application/json' },
      });
    }
  }

  await env.DB.prepare(
    `INSERT INTO quarantine (delivery_id, publication_id, received_at, reason, metadata_text, r2_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.deliveryId,
      entry.publicationId,
      receivedAt,
      entry.reason,
      entry.metadataText,
      r2Key,
    )
    .run();
}
