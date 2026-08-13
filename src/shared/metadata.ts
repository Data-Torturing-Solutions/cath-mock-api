/**
 * Validation of the mandatory `metadata` part.
 *
 * Two deliberate choices, both from the "silent drops" risk: a publication we
 * reject four times is gone forever, so we (a) never reject on anything the
 * spec does not actually mandate, and (b) return warnings rather than errors
 * for things that are suspicious but survivable.
 */
import { isKnownListType } from './list-types.js';
import {
  LANGUAGES,
  SENSITIVITIES,
  type Language,
  type PublicationMetadata,
  type Sensitivity,
} from './types.js';

export interface MetadataValidation {
  ok: boolean;
  /** Present whenever the eight mandatory fields parsed, even if warnings exist. */
  value?: PublicationMetadata;
  errors: string[];
  warnings: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ISO 8601 instants. CaTH sends `2025-02-05T00:00:00Z`, but we also accept
 * fractional seconds and numeric offsets rather than rejecting a publication
 * over a formatting detail the spec does not pin down.
 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

export function isIso8601(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function requireString(
  raw: Record<string, unknown>,
  field: string,
  errors: string[],
): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) {
    errors.push(`${field}: missing (mandatory)`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field}: must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requireIso(
  raw: Record<string, unknown>,
  field: string,
  errors: string[],
): string | undefined {
  const value = requireString(raw, field, errors);
  if (value === undefined) return undefined;
  if (!isIso8601(value)) {
    errors.push(`${field}: not an ISO 8601 instant (got ${JSON.stringify(value)})`);
    return undefined;
  }
  return value;
}

export function validateMetadata(raw: unknown): MetadataValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['metadata: must be a JSON object'], warnings };
  }
  const obj = raw as Record<string, unknown>;

  const publicationId = requireString(obj, 'publicationId', errors);
  if (publicationId !== undefined && !UUID_RE.test(publicationId)) {
    errors.push(`publicationId: not a UUID (got ${JSON.stringify(publicationId)})`);
  }

  const listType = requireString(obj, 'listType', errors);
  if (listType !== undefined && !isKnownListType(listType)) {
    errors.push(
      `listType: ${JSON.stringify(listType)} is not a known list type. ` +
        'If HMCTS have added one, run `npm run refresh`.',
    );
  }

  const locationName = requireString(obj, 'locationName', errors);

  const sensitivity = requireString(obj, 'sensitivity', errors);
  if (sensitivity !== undefined && !(SENSITIVITIES as readonly string[]).includes(sensitivity)) {
    errors.push(`sensitivity: must be one of ${SENSITIVITIES.join(' | ')} (got ${sensitivity})`);
  }

  const language = requireString(obj, 'language', errors);
  if (language !== undefined && !(LANGUAGES as readonly string[]).includes(language)) {
    errors.push(`language: must be one of ${LANGUAGES.join(' | ')} (got ${language})`);
  }

  const contentDate = requireIso(obj, 'contentDate', errors);
  const displayFrom = requireIso(obj, 'displayFrom', errors);
  const displayTo = requireIso(obj, 'displayTo', errors);

  // Survivable oddities: log them, do not reject. A rejected publication is
  // retried three times and then lost.
  if (displayFrom && displayTo && Date.parse(displayTo) < Date.parse(displayFrom)) {
    warnings.push('displayTo is before displayFrom');
  }
  if (displayTo && Date.parse(displayTo) < Date.now()) {
    warnings.push('displayTo is already in the past; publication arrives expired');
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    value: {
      ...obj,
      publicationId: publicationId as string,
      listType: listType as string,
      locationName: locationName as string,
      contentDate: contentDate as string,
      sensitivity: sensitivity as Sensitivity,
      language: language as Language,
      displayFrom: displayFrom as string,
      displayTo: displayTo as string,
    },
    errors,
    warnings,
  };
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
