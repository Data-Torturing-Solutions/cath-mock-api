/**
 * The generator's public surface: one call produces a complete publication --
 * metadata, plus either a JSON payload or a flat file.
 */
import { LIST_TYPE_NAMES } from '../list-types.js';
import type { Language, PublicationMetadata, Sensitivity } from '../types.js';
import { generateFlatFile, type FlatFile } from './flat-files.js';
import { jurisdictionFor, pickVenue, type Venue } from './vocab.js';
import { generatePayload, schemaFileFor, type PayloadSize } from './payload.js';
import { Rng } from './random.js';

export * from './flat-files.js';
export * from './payload.js';
export * from './people.js';
export * from './random.js';
export * from './vocab.js';
export { SCHEMAS, SCHEMA_FOR_LIST_TYPE, LIST_TYPES_WITHOUT_OWN_SCHEMA } from './schemas.js';

export interface PublicationOptions {
  seed?: number | string;
  rng?: Rng;
  listType?: string;
  contentDate?: Date;
  /** 'json' produces a payload part, 'file' a flat file, 'auto' mixes them. */
  artefact?: 'json' | 'file' | 'auto';
  size?: PayloadSize;
  sensitivity?: Sensitivity;
  language?: Language;
  publicationId?: string;
  /** Publications displayed from a future date arrive at 1AM UTC that morning. */
  displayFromOffsetDays?: number;
  displayDurationDays?: number;
  venue?: Venue;
}

export interface GeneratedPublication {
  metadata: PublicationMetadata;
  payload: unknown | null;
  file: FlatFile | null;
  schemaFile: string;
  venue: Venue;
}

function startOfUtcDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/**
 * The realistic sensitivity mix. Almost everything CaTH pushes is PUBLIC; the
 * rest exists so the sensitivity gating on read paths is actually exercised.
 */
function pickSensitivity(rng: Rng): Sensitivity {
  return rng.weighted<Sensitivity>([
    ['PUBLIC', 88],
    ['PRIVATE', 9],
    ['CLASSIFIED', 3],
  ]);
}

function pickLanguage(rng: Rng, listType: string, venue: Venue): Language {
  // Welsh and bilingual publications come from Welsh venues, and must not
  // supersede their English counterparts -- same list type, same location,
  // same content date, different language.
  const welsh = /wales|cardiff|swansea|newport|wrexham|caernarfon|merthyr|aberystwyth|llandudno|haverfordwest|prestatyn|mold/i;
  const isWelsh = welsh.test(venue.name) || welsh.test(venue.address?.county ?? '');
  if (!isWelsh) return 'ENGLISH';
  return rng.weighted<Language>([
    ['ENGLISH', 60],
    ['WELSH', 20],
    ['BI_LINGUAL', 20],
  ]);
}

export function generatePublication(options: PublicationOptions = {}): GeneratedPublication {
  const rng = options.rng ?? new Rng(options.seed ?? Math.floor(Math.random() * 2 ** 32));
  const listType = options.listType ?? rng.pick(LIST_TYPE_NAMES);
  const jurisdiction = jurisdictionFor(listType);
  const venue = options.venue ?? pickVenue(rng, jurisdiction);
  const contentDate = startOfUtcDay(options.contentDate ?? new Date());
  const publicationId = options.publicationId ?? rng.uuid();

  const displayFrom = addDays(contentDate, options.displayFromOffsetDays ?? 0);
  const displayTo = addDays(displayFrom, options.displayDurationDays ?? 1);

  const metadata: PublicationMetadata = {
    publicationId,
    listType,
    locationName: venue.name,
    contentDate: `${contentDate.toISOString().slice(0, 19)}Z`,
    sensitivity: options.sensitivity ?? pickSensitivity(rng),
    language: options.language ?? pickLanguage(rng, listType, venue),
    displayFrom: `${displayFrom.toISOString().slice(0, 19)}Z`,
    displayTo: `${displayTo.toISOString().slice(0, 19)}Z`,
  };

  const wantsFile =
    options.artefact === 'file'
      ? true
      : options.artefact === 'json'
        ? false
        // Roughly the real mix: most publications are JSON, a meaningful
        // minority are flat files.
        : rng.chance(0.2);

  if (wantsFile) {
    return {
      metadata,
      payload: null,
      file: generateFlatFile({
        rng,
        listType,
        jurisdiction,
        venue,
        contentDate,
        publicationId,
      }),
      schemaFile: schemaFileFor(listType),
      venue,
    };
  }

  const generated = generatePayload({
    listType,
    rng,
    contentDate,
    venue,
    size: options.size,
  });

  return {
    metadata,
    payload: generated.payload,
    file: null,
    schemaFile: generated.schemaFile,
    venue,
  };
}
