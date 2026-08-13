/**
 * The `multipart/form-data` body CaTH posts: a mandatory `metadata` part, an
 * optional `payload` part (JSON publications) and an optional `file` part
 * (flat-file publications, named `{uuid}.{ext}`).
 *
 * Both directions live here so the simulator builds exactly what the receiver
 * parses.
 */
import { FLAT_FILE_TYPES } from './types.js';

export interface ParsedParts {
  /** Raw text of the `metadata` part, or null when it was absent entirely. */
  metadataText: string | null;
  /** Raw text of the `payload` part. The literal `null` payload is normalised away. */
  payloadText: string | null;
  fileBytes: ArrayBuffer | null;
  fileName: string | null;
  fileMime: string | null;
  /** Names of parts CaTH did not promise us -- worth logging, never fatal. */
  unexpectedParts: string[];
  parseError: string | null;
}

const EMPTY: ParsedParts = {
  metadataText: null,
  payloadText: null,
  fileBytes: null,
  fileName: null,
  fileMime: null,
  unexpectedParts: [],
  parseError: null,
};

async function partToText(value: File | string): Promise<string> {
  return typeof value === 'string' ? value : await value.text();
}

export async function parseCathMultipart(request: Request): Promise<ParsedParts> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return { ...EMPTY, parseError: `expected multipart/form-data, got ${contentType || '(none)'}` };
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return { ...EMPTY, parseError: `could not parse multipart body: ${(err as Error).message}` };
  }

  const result: ParsedParts = { ...EMPTY, unexpectedParts: [] };

  for (const key of new Set(form.keys())) {
    if (key !== 'metadata' && key !== 'payload' && key !== 'file') result.unexpectedParts.push(key);
  }

  const metadata = form.get('metadata');
  if (metadata !== null) result.metadataText = await partToText(metadata);

  const payload = form.get('payload');
  if (payload !== null) {
    const text = await partToText(payload);
    // "payload will be null for flat file publications" -- that arrives as the
    // literal four characters, not an absent part.
    result.payloadText = text.trim() === 'null' || text.trim() === '' ? null : text;
  }

  const file = form.get('file');
  if (file !== null && typeof file !== 'string') {
    result.fileBytes = await file.arrayBuffer();
    result.fileName = file.name || null;
    result.fileMime = file.type || guessMime(file.name) || 'application/octet-stream';
  } else if (typeof file === 'string' && file.trim() !== '') {
    // A `file` part that is not actually a file. Keep the bytes; flag it.
    result.fileBytes = new TextEncoder().encode(file).buffer as ArrayBuffer;
    result.fileName = null;
    result.fileMime = 'application/octet-stream';
  }

  return result;
}

export function guessMime(fileName: string | null): string | null {
  if (!fileName) return null;
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return FLAT_FILE_TYPES[ext] ?? null;
}

export function extensionFor(fileName: string | null, mime: string | null): string {
  const fromName = fileName?.split('.').pop()?.toLowerCase();
  if (fromName && fromName in FLAT_FILE_TYPES) return fromName;
  const entry = Object.entries(FLAT_FILE_TYPES).find(([, m]) => m === mime);
  return entry ? entry[0] : 'bin';
}

export interface BuildOptions {
  metadata: unknown;
  payload?: unknown;
  file?: { bytes: ArrayBuffer | Uint8Array; name: string; mime: string };
  /** Emit `metadata` as a raw string rather than JSON -- used by the chaos scenarios. */
  rawMetadata?: string;
  omitMetadata?: boolean;
}

export function buildCathMultipart(options: BuildOptions): FormData {
  const form = new FormData();

  if (!options.omitMetadata) {
    const text = options.rawMetadata ?? JSON.stringify(options.metadata);
    form.append('metadata', new Blob([text], { type: 'application/json' }), 'metadata.json');
  }

  if (options.file) {
    // Flat-file publications carry an explicitly null payload.
    form.append('payload', new Blob(['null'], { type: 'application/json' }), 'payload.json');
    const bytes = options.file.bytes instanceof Uint8Array
      ? options.file.bytes
      : new Uint8Array(options.file.bytes);
    form.append('file', new Blob([bytes], { type: options.file.mime }), options.file.name);
  } else if (options.payload !== undefined) {
    form.append(
      'payload',
      new Blob([JSON.stringify(options.payload)], { type: 'application/json' }),
      'payload.json',
    );
  }

  return form;
}
