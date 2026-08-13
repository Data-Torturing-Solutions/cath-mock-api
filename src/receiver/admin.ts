/**
 * Read endpoints for inspecting what arrived. Not part of the CaTH contract --
 * these exist so you can prove to yourself (and to HMCTS) that nothing was
 * dropped.
 *
 * Every read here is gated by sensitivity independently of AUTH_MODE.
 */
import { canRead, readableSensitivities, type AuthResult } from './auth.js';
import { timingSafeEqual } from './jwt.js';
import type { Env } from './env.js';
import type { PublicationRow } from '../shared/types.js';

export function isAdmin(request: Request, env: Env, auth: AuthResult): boolean {
  if (auth.valid) return true;
  const presented = request.headers.get('x-admin-token');
  if (!presented || !env.ADMIN_TOKEN) return false;
  return timingSafeEqual(presented, env.ADMIN_TOKEN);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function clampLimit(raw: string | null, fallback = 50): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 500);
}

export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  auth: AuthResult,
): Promise<Response> {
  const elevated = isAdmin(request, env, auth);
  // An unelevated caller sees PUBLIC only. This is deliberately not tied to
  // AUTH_MODE: PRIVATE and CLASSIFIED must never leave an open endpoint.
  const allowed = readableSensitivities(elevated ? { present: true, valid: true } : auth);
  const placeholders = allowed.map(() => '?').join(', ');

  const segments = url.pathname.split('/').filter(Boolean); // ['admin', ...]
  const resource = segments[1] ?? '';

  if (request.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  if (resource === 'stats') {
    const publications = await env.DB.prepare(
      `SELECT state, COUNT(*) AS count FROM publications GROUP BY state`,
    ).all<{ state: string; count: number }>();
    const deliveries = await env.DB.prepare(
      `SELECT method, status_sent, COUNT(*) AS count
         FROM deliveries GROUP BY method, status_sent ORDER BY count DESC`,
    ).all<{ method: string; status_sent: number; count: number }>();
    const quarantined = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM quarantine WHERE resolved = 0`,
    ).first<{ count: number }>();
    const authSplit = await env.DB.prepare(
      `SELECT auth_used, COUNT(*) AS count FROM deliveries GROUP BY auth_used`,
    ).all<{ auth_used: number; count: number }>();

    return json({
      publicationsByState: publications.results ?? [],
      deliveriesByOutcome: deliveries.results ?? [],
      quarantinedUnresolved: quarantined?.count ?? 0,
      deliveriesByAuth: authSplit.results ?? [],
      visibility: elevated ? 'all' : 'PUBLIC only (present a bearer token for more)',
    });
  }

  if (resource === 'deliveries') {
    const limit = clampLimit(url.searchParams.get('limit'));
    const publicationId = url.searchParams.get('publicationId');
    const statement = publicationId
      ? env.DB.prepare(
        `SELECT * FROM deliveries WHERE publication_id = ? ORDER BY id DESC LIMIT ?`,
      ).bind(publicationId, limit)
      : env.DB.prepare(`SELECT * FROM deliveries ORDER BY id DESC LIMIT ?`).bind(limit);

    const { results } = await statement.all();
    return json({ count: results?.length ?? 0, deliveries: results ?? [] });
  }

  if (resource === 'quarantine') {
    if (!elevated) return json({ error: 'forbidden', detail: 'quarantine requires auth' }, 403);
    const limit = clampLimit(url.searchParams.get('limit'));
    const { results } = await env.DB.prepare(
      `SELECT * FROM quarantine ORDER BY id DESC LIMIT ?`,
    )
      .bind(limit)
      .all();
    return json({ count: results?.length ?? 0, quarantine: results ?? [] });
  }

  if (resource === 'publications') {
    const publicationId = segments[2];

    if (!publicationId) {
      const limit = clampLimit(url.searchParams.get('limit'));
      const state = url.searchParams.get('state');
      const listType = url.searchParams.get('listType');

      const filters = [`sensitivity IN (${placeholders})`];
      const binds: unknown[] = [...allowed];
      if (state) {
        filters.push('state = ?');
        binds.push(state);
      }
      if (listType) {
        filters.push('list_type = ?');
        binds.push(listType);
      }
      binds.push(limit);

      const { results } = await env.DB.prepare(
        `SELECT * FROM publications WHERE ${filters.join(' AND ')}
          ORDER BY last_seen_at DESC LIMIT ?`,
      )
        .bind(...binds)
        .all<PublicationRow>();

      return json({ count: results?.length ?? 0, publications: results ?? [] });
    }

    const row = await env.DB.prepare('SELECT * FROM publications WHERE publication_id = ?')
      .bind(publicationId)
      .first<PublicationRow>();
    if (!row) return json({ error: 'not_found' }, 404);
    if (!canRead(row.sensitivity, elevated ? { present: true, valid: true } : auth)) {
      // Do not confirm existence of a non-public publication to an anonymous caller.
      return json({ error: 'not_found' }, 404);
    }

    if (segments[3] === 'artefact') {
      if (!row.r2_key) return json({ error: 'no_artefact', artefactKind: row.artefact_kind }, 404);
      const object = await env.ARTEFACTS.get(row.r2_key);
      if (!object) return json({ error: 'artefact_missing_from_r2', key: row.r2_key }, 404);
      return new Response(object.body, {
        headers: {
          'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
          'content-disposition': `attachment; filename="${row.file_name ?? `${publicationId}.json`}"`,
        },
      });
    }

    const { results: history } = await env.DB.prepare(
      `SELECT * FROM deliveries WHERE publication_id = ? ORDER BY id DESC LIMIT 50`,
    )
      .bind(publicationId)
      .all();

    return json({ publication: row, deliveries: history ?? [] });
  }

  return json({ error: 'not_found' }, 404);
}
