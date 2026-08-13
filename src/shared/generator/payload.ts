/**
 * Payload generation.
 *
 * Generated from the 42 real HMCTS schemas rather than from imagination, so
 * output validates by construction -- but with a domain vocabulary layered on
 * top, because a schema-valid payload full of "string" is useless for judging
 * whether the receiver handles a real court list.
 *
 * The walker covers all four shapes HMCTS actually publish:
 *   - the deep `document/venue/courtLists/.../case` tree (strategic lists)
 *   - flat arrays of hearing rows (non-strategic lists)
 *   - the PDDA `DailyList` / `FirmList` / `WarnedList` wrappers
 *   - the magistrates `document`-rooted lists
 */
import { caseName, judicialName, partyName, personName, tribunalMemberName, PROVENANCE, TEST_SENTINEL, type Jurisdiction } from './people.js';
import type { Rng } from './random.js';
import { SCHEMAS, SCHEMA_FOR_LIST_TYPE, type JsonSchema } from './schemas.js';
import {
  CASE_SEQUENCE_INDICATORS,
  CASE_TYPES,
  LISTING_NOTES,
  REPORTING_RESTRICTIONS,
  caseNumber,
  caseUrn,
  channel,
  courtRoomName,
  hearingType,
  jurisdictionFor,
  pickVenue,
  sittingWindow,
  type Venue,
} from './vocab.js';

export type PayloadSize = 'minimal' | 'typical' | 'deep';

export interface GenerateOptions {
  listType: string;
  rng: Rng;
  contentDate?: Date;
  venue?: Venue;
  size?: PayloadSize;
}

interface Ctx {
  rng: Rng;
  listType: string;
  jurisdiction: Jurisdiction;
  venue: Venue;
  contentDate: Date;
  size: PayloadSize;
  root: JsonSchema;
  depth: number;
  /** Carried down the tree so a sitting's cases share its start time. */
  currentSitting: { start: Date; end: Date };
}

const MAX_DEPTH = 24;

/* ------------------------------------------------------------------ helpers */

function iso(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function ddmmyyyy(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getUTCFullYear()}`;
}

function amPm(date: Date): string {
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const suffix = hours < 12 ? 'am' : 'pm';
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0 ? `${twelve}${suffix}` : `${twelve}:${String(minutes).padStart(2, '0')}${suffix}`;
}

function hhmm(date: Date): string {
  return date.toISOString().slice(11, 16);
}

/** `#/$defs/address` and friends. */
function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  if (!ref.startsWith('#/')) return null;
  let node: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[key];
  }
  return node && typeof node === 'object' ? (node as JsonSchema) : null;
}

function deref(schema: JsonSchema, ctx: Ctx): JsonSchema {
  let current = schema;
  for (let i = 0; i < 8 && typeof current['$ref'] === 'string'; i++) {
    const resolved = resolveRef(current['$ref'] as string, ctx.root);
    if (!resolved) break;
    const { $ref: _discard, ...rest } = current;
    current = { ...resolved, ...rest };
  }
  return current;
}

/* -------------------------------------------------- pattern-driven fallback */

/**
 * The vendored schemas use a small, closed set of patterns. Rather than a
 * general regex solver, each one gets a recipe -- and anything unrecognised
 * falls back to trying candidates until one matches.
 */
function satisfyPattern(pattern: string, ctx: Ctx): string | null {
  const { start } = ctx.currentSitting;

  switch (pattern) {
    case '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}([.]\\d{1,9})?Z$':
    case '^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}([.]\\d{1,9})?Z)?$':
      return iso(start);
    case '^\\d{1,2}([:.]\\d{2})?[ap]m\\s*$':
      return amPm(start);
    case '^\\d{2}/\\d{2}/\\d{4}$':
      return ddmmyyyy(ctx.contentDate);
    case '^\\d{2}:\\d{2}$':
      return hhmm(start);
    case '^\\d{2}:\\d{2}:\\d{2}$':
      return start.toISOString().slice(11, 19);
    case '^[A-Z]{3}$':
      return ctx.rng.pick(['CIV', 'FAM', 'CRI', 'TRI', 'APP']);
    case '^[A-Z][0-9]{8}$':
      return `${String.fromCharCode(65 + ctx.rng.int(0, 25))}${String(ctx.rng.int(0, 99_999_999)).padStart(8, '0')}`;
    case '^([A-Za-z]{2}|[A-Za-z][0-9])$':
      return ctx.rng.pick(['AB', 'CD', 'EF', 'A1', 'B2']);
    case '^.?$':
      return '';
    default:
      break;
  }

  // The long ISO-date pattern, and anything else, by trial.
  const candidates = [
    ctx.contentDate.toISOString().slice(0, 10),
    iso(start),
    ddmmyyyy(ctx.contentDate),
    amPm(start),
    hhmm(start),
    'Not specified',
    '',
  ];
  const regex = safeRegex(pattern);
  if (!regex) return null;
  return candidates.find((candidate) => regex.test(candidate)) ?? null;
}

function safeRegex(pattern: string): RegExp | null {
  try {
    // `(?s)` is a Java inline flag; JS expresses it as the `s` flag.
    return pattern.startsWith('(?s)')
      ? new RegExp(pattern.slice(4), 's')
      : new RegExp(pattern);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- domain vocabulary */

/**
 * Realistic values keyed on property name. Anything not listed here falls
 * through to schema examples and then to a generic filler -- the point is to
 * be right about the fields a reader would notice, not about every field.
 */
function domainValue(property: string, ctx: Ctx): string | null {
  const { rng, venue, jurisdiction } = ctx;
  const { start, end } = ctx.currentSitting;
  const address = venue.address;

  switch (property) {
    /* document */
    case 'documentName':
      return `${venue.name} ${ctx.listType.replace(/_/g, ' ').toLowerCase()} ${ctx.contentDate.toISOString().slice(0, 10)}`;
    case 'publicationDate':
      return iso(ctx.contentDate);
    case 'version':
      return `1.${rng.int(0, 4)}`;
    case 'provenance':
      return PROVENANCE;

    /* venue and court house */
    case 'venueName':
    case 'courtHouseName':
    case 'venue':
    case 'venue/platform':
      return venue.name;
    case 'venueTelephone':
    case 'venueContactTelephone':
      return `01${rng.int(100, 999)} ${rng.int(100_000, 999_999)}`;
    case 'venueEmail':
    case 'venueContactEmail':
      return `enquiries@${venue.slug.slice(0, 24)}.example`;
    case 'courtHouseCode':
      return String(rng.int(100, 999));
    case 'courtRoomName':
      return courtRoomName(rng);

    /* address parts */
    case 'town':
      return address?.town ?? 'Norwich';
    case 'county':
      return address?.county ?? 'Norfolk';
    case 'postCode':
    case 'postcode':
      return address?.postCode ?? 'NR1 3PL';

    /* session and sitting */
    case 'sittingStart':
      return iso(start);
    case 'sittingEnd':
      return iso(end);
    case 'time':
    case 'hearingTime':
    case 'sittingTime':
      return amPm(start);
    case 'date':
    case 'hearingDate':
      return ddmmyyyy(ctx.contentDate);
    case 'channel':
    case 'sessionChannel':
      return channel(rng);
    case 'duration':
      return `${rng.pick([30, 60, 90, 120])} minutes`;

    /* judiciary */
    case 'judiciary':
    case 'judge':
    case 'judges':
    case 'johKnownAs':
    case 'johTitle':
    case 'presidingJudge':
      return judicialName(rng);
    case 'members':
    case 'panel':
      return `${tribunalMemberName(rng)}, ${tribunalMemberName(rng)}`;

    /* case */
    case 'caseName':
    case 'caseTitle':
      return caseName(rng, jurisdiction);
    case 'caseNumber':
    case 'caseReferenceNumber':
    case 'caseReference':
      return caseNumber(rng, jurisdiction);
    case 'caseUrn':
    case 'urn':
      return caseUrn(rng);
    case 'caseType':
    case 'type':
      return rng.pick(CASE_TYPES);
    case 'caseSequenceIndicator':
      return rng.pick(CASE_SEQUENCE_INDICATORS);
    case 'hearingType':
    case 'hearingPlatform':
      return hearingType(rng, jurisdiction);
    case 'caseDetails':
    case 'hearingDetails':
      return `${caseName(rng, jurisdiction)} -- ${hearingType(rng, jurisdiction)}`;
    case 'listingNotes':
    case 'listingRequirements':
      return rng.pick(LISTING_NOTES);
    case 'reportingRestriction':
    case 'reportingRestrictionDetail':
      return rng.pick(REPORTING_RESTRICTIONS);
    case 'additionalInformation':
      return rng.chance(0.3) ? rng.pick(LISTING_NOTES) : '';

    /* parties -- companies, never synthetic people next to charges */
    case 'applicant':
    case 'claimant':
    case 'petitioner':
    case 'appellant':
    case 'partyName':
      return partyName(rng);
    case 'respondent':
    case 'defendant':
    case 'defendantName':
      return partyName(rng);
    case 'representative':
    case 'applicantRepresentative':
    case 'respondentRepresentative':
    case 'prosecutingAuthority':
      return `${TEST_SENTINEL} ${rng.pick(['Testerton', 'Fakeworth', 'Mockley'])} & Co Solicitors`;
    case 'name':
      return personName(rng);

    default:
      return pddaValue(property, ctx);
  }
}

/**
 * The Crown PDDA lists are PascalCase and, uniquely, carry defendant personal
 * details -- forename, surname, date of birth, age, sex, nationality, prisoner
 * ID -- alongside charges and offence codes.
 *
 * This is precisely the shape the generator must not make realistic. Names come
 * from the coined pool, every offence is sentinel-marked as simulator output,
 * and dates of birth are fixed rather than plausible. The structure stays real
 * so the receiver is genuinely exercised; the person never is.
 */
function pddaValue(property: string, ctx: Ctx): string | null {
  const { rng } = ctx;

  switch (property) {
    case 'CitizenNameForename':
      return personName(rng).split(' ')[0] as string;
    case 'CitizenNameSurname':
    case 'MaskedName':
      return personName(rng).split(' ')[1] as string;
    case 'CitizenNameTitle':
      return rng.pick(['Mr', 'Mrs', 'Ms', 'Miss']);
    case 'CitizenNameSuffix':
    case 'CitizenNameRequestedName':
      return '';
    case 'OrganisationName':
      return partyName(rng);

    case 'DateOfBirth':
    case 'BirthDate':
      // Deliberately constant: a varying, plausible DOB next to a charge is
      // the artefact this module exists to avoid producing.
      return '1990-01-01';
    case 'Sex':
      return rng.pick(['Not specified', 'Not known']);
    case 'Nationality':
      return 'Not specified';
    case 'PrisonerID':
      return `${TEST_SENTINEL.replace(/[[\]]/g, '')}${rng.int(10_000, 99_999)}`;
    case 'PrisonLocation':
      return `${TEST_SENTINEL} Simulator Holding`;

    case 'OffenceStatement':
    case 'Charges':
      return `${TEST_SENTINEL} Placeholder offence -- simulator data, not a real charge`;
    case 'CJSoffenceCode':
      return `TS${rng.int(10_000, 99_999)}`;

    case 'URN':
      return caseUrn(rng);
    case 'ProsecutingAuthority':
    case 'ProsecutingOrganisation':
      return `${TEST_SENTINEL} Simulator Prosecutions`;
    case 'ProsecutingReference':
      return `SIM/${rng.int(1000, 9999)}`;
    case 'Advocate':
    case 'VerifiedBy':
      return `${TEST_SENTINEL} ${rng.pick(['Testerton', 'Fakeworth', 'Mockley'])}`;

    case 'HearingDescription':
      return hearingType(rng, ctx.jurisdiction);
    case 'ListNote':
    case 'SittingNote':
    case 'TimeMarkingNote':
      return rng.chance(0.3) ? rng.pick(LISTING_NOTES) : '';
    case 'CourtRoomNumber':
      return String(rng.int(1, 12));
    case 'CourtHouseShortName':
      return ctx.venue.name.split(/\s+/).slice(0, 2).join(' ');
    case 'CourtHouseTelephone':
      return `01${rng.int(100, 999)} ${rng.int(100_000, 999_999)}`;
    case 'CourtHouseType':
      return 'Crown Court';
    case 'DocumentType':
      return ctx.listType.replace(/_/g, ' ');
    case 'DocumentID':
    case 'UniqueID':
      return rng.uuid();
    case 'PublishedTime':
      return iso(ctx.contentDate);

    default: {
      // Fall back to the camelCase table so `CaseNumber`, `HearingType`,
      // `CourtHouseName` and friends resolve without being listed twice.
      const camel = property.charAt(0).toLowerCase() + property.slice(1);
      return camel === property ? null : domainValue(camel, ctx);
    }
  }
}

/* ------------------------------------------------------------ array sizing */

/**
 * Array sizes by level. `deep` means multi-courtroom and multi-session -- a
 * busy Crown court day, a few hundred cases -- not a combinatorial explosion.
 * Six nested levels multiply fast, so the top of the tree stays narrow while
 * the middle widens.
 */
const ARRAY_SIZES: Record<string, Record<PayloadSize, [number, number]>> = {
  courtLists: { minimal: [1, 1], typical: [1, 2], deep: [1, 2] },
  courtRoom: { minimal: [1, 1], typical: [2, 4], deep: [4, 6] },
  session: { minimal: [1, 1], typical: [1, 2], deep: [2, 2] },
  sittings: { minimal: [1, 1], typical: [2, 5], deep: [4, 6] },
  hearing: { minimal: [1, 1], typical: [1, 2], deep: [1, 2] },
  case: { minimal: [1, 1], typical: [1, 2], deep: [1, 2] },
  party: { minimal: [1, 1], typical: [2, 2], deep: [2, 2] },
  judiciary: { minimal: [1, 1], typical: [1, 2], deep: [1, 2] },
  line: { minimal: [1, 1], typical: [2, 3], deep: [2, 3] },
  /** Top-level array, i.e. a flat non-strategic list. */
  '': { minimal: [1, 2], typical: [8, 20], deep: [40, 70] },
};

const DEFAULT_ARRAY_SIZE: Record<PayloadSize, [number, number]> = {
  minimal: [1, 1],
  typical: [1, 3],
  deep: [2, 3],
};

function arraySize(property: string, ctx: Ctx, minItems: number): number {
  const table = ARRAY_SIZES[property] ?? DEFAULT_ARRAY_SIZE;
  const [low, high] = table[ctx.size] ?? [1, 2];
  return Math.max(minItems, ctx.rng.int(low, high));
}

/* ------------------------------------------------------------- the walker */

/**
 * Collapses `allOf` / `oneOf` / `anyOf` / `if-then-else` into one schema before
 * anything is generated.
 *
 * Picking a branch and generating from it in isolation is not enough -- the
 * branch usually carries only `required`, and the parent carries the `type` and
 * `properties`. HMCTS use this shape a lot: the SJP press lists say "if
 * partyRole is ACCUSED then individualDetails or organisationDetails, else
 * organisationDetails", and the Crown warned list uses a bare `oneOf` under a
 * typed object.
 *
 * `if` always takes the `then` path: we generate the condition, so it holds by
 * construction, and `else` can never apply.
 */
function flattenSchema(schema: JsonSchema, ctx: Ctx): JsonSchema {
  let node = deref(schema, ctx);

  for (let pass = 0; pass < 6; pass++) {
    let changed = false;

    if (Array.isArray(node['allOf'])) {
      const branches = node['allOf'] as JsonSchema[];
      node = branches.reduce<JsonSchema>(
        (acc, branch) => mergeSchemas(acc, deref(branch, ctx)),
        { ...node },
      );
      delete node['allOf'];
      changed = true;
    }

    if (node['if'] !== undefined) {
      const condition = deref(node['if'] as JsonSchema, ctx);
      const consequent = node['then'] ? deref(node['then'] as JsonSchema, ctx) : {};
      const { if: _if, then: _then, else: _else, ...rest } = node;
      node = mergeSchemas(mergeSchemas(rest as JsonSchema, condition), consequent);
      changed = true;
    }

    for (const combinator of ['oneOf', 'anyOf'] as const) {
      const branches = node[combinator];
      if (Array.isArray(branches) && branches.length > 0) {
        const chosen = deref(ctx.rng.pick(branches as JsonSchema[]), ctx);
        const { [combinator]: _discard, ...rest } = node;
        node = mergeSchemas(rest as JsonSchema, chosen);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return node;
}

function generateNode(schema: JsonSchema, property: string, ctx: Ctx): unknown {
  if (ctx.depth > MAX_DEPTH) return null;
  const node = flattenSchema(schema, ctx);

  if (Array.isArray(node['enum'])) return ctx.rng.pick(node['enum'] as unknown[]);
  if (node['const'] !== undefined) return node['const'];

  const type = Array.isArray(node['type'])
    ? (node['type'] as string[]).find((t) => t !== 'null') ?? 'string'
    : (node['type'] as string | undefined);

  switch (type) {
    case 'object':
      return generateObject(node, ctx);
    case 'array':
      return generateArray(node, property, ctx);
    case 'integer':
    case 'number': {
      const min = typeof node['minimum'] === 'number' ? (node['minimum'] as number) : 1;
      const max = typeof node['maximum'] === 'number' ? (node['maximum'] as number) : min + 20;
      const value = ctx.rng.int(Math.ceil(min), Math.floor(max));
      return type === 'integer' ? value : value + Math.round(ctx.rng.next() * 100) / 100;
    }
    case 'boolean':
      return ctx.rng.chance(0.3);
    case 'null':
      return null;
    case 'string':
    default:
      return generateString(node, property, ctx);
  }
}

function mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  const merged: JsonSchema = { ...a, ...b };
  if (a['properties'] || b['properties']) {
    merged['properties'] = {
      ...(a['properties'] as object ?? {}),
      ...(b['properties'] as object ?? {}),
    };
  }
  if (Array.isArray(a['required']) || Array.isArray(b['required'])) {
    merged['required'] = [
      ...new Set([...(a['required'] as string[] ?? []), ...(b['required'] as string[] ?? [])]),
    ];
  }
  return merged;
}

function generateObject(node: JsonSchema, ctx: Ctx): Record<string, unknown> {
  const properties = (node['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = new Set((node['required'] as string[] | undefined) ?? []);
  const optionalChance = ctx.size === 'minimal' ? 0.15 : ctx.size === 'deep' ? 0.95 : 0.7;

  const result: Record<string, unknown> = {};
  const child: Ctx = { ...ctx, depth: ctx.depth + 1 };

  for (const [name, propertySchema] of Object.entries(properties)) {
    if (!required.has(name) && !ctx.rng.chance(optionalChance)) continue;

    // A sitting owns its time window; everything below it inherits.
    if (name === 'sittings' || name === 'sitting') {
      result[name] = generateNode(propertySchema, name, child);
      continue;
    }
    result[name] = generateNode(propertySchema, name, child);
  }

  // Required properties the schema declares but does not describe still have
  // to be present, or the output fails its own schema.
  for (const name of required) {
    if (!(name in result)) {
      result[name] = properties[name]
        ? generateNode(properties[name] as JsonSchema, name, child)
        : (domainValue(name, ctx) ?? '');
    }
  }

  return result;
}

function generateArray(node: JsonSchema, property: string, ctx: Ctx): unknown[] {
  const items = (node['items'] ?? { type: 'string' }) as JsonSchema;
  const minItems = typeof node['minItems'] === 'number' ? (node['minItems'] as number) : 0;
  const maxItems = typeof node['maxItems'] === 'number' ? (node['maxItems'] as number) : Infinity;
  const count = Math.min(arraySize(property, ctx, minItems), maxItems);

  return Array.from({ length: count }, () => {
    // Each sitting gets its own window, so a day reads as a day rather than as
    // every hearing starting at once.
    const child: Ctx =
      property === 'sittings' || property === 'sitting'
        ? { ...ctx, depth: ctx.depth + 1, currentSitting: sittingWindow(ctx.rng, ctx.contentDate) }
        : { ...ctx, depth: ctx.depth + 1 };
    return generateNode(items, `${property}Item`, child);
  });
}

interface StringConstraints {
  regex: RegExp | null;
  minLength: number;
  maxLength: number;
  format: string | null;
}

/** ajv-formats is strict about these, so the generator has to be too. */
function matchesFormat(value: string, format: string | null): boolean {
  switch (format) {
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
    case 'time':
      // RFC 3339 full-time: the offset is not optional.
      return /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
    case 'email':
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
    case 'uri':
      return /^[a-z][a-z0-9+.-]*:\S*$/i.test(value);
    default:
      return true;
  }
}

function constraintsOf(node: JsonSchema): StringConstraints {
  const pattern = typeof node['pattern'] === 'string' ? (node['pattern'] as string) : null;
  return {
    regex: pattern ? safeRegex(pattern) : null,
    minLength: typeof node['minLength'] === 'number' ? (node['minLength'] as number) : 0,
    maxLength: typeof node['maxLength'] === 'number' ? (node['maxLength'] as number) : Infinity,
    format: typeof node['format'] === 'string' ? (node['format'] as string) : null,
  };
}

function satisfies(value: string, c: StringConstraints): boolean {
  if (value.length < c.minLength || value.length > c.maxLength) return false;
  if (c.regex && !c.regex.test(value)) return false;
  return matchesFormat(value, c.format);
}

/** Trims an otherwise-good candidate to a maxLength rather than discarding it. */
function fit(value: string, c: StringConstraints): string {
  return c.maxLength !== Infinity && value.length > c.maxLength
    ? value.slice(0, c.maxLength).trimEnd()
    : value;
}

function generateString(node: JsonSchema, property: string, ctx: Ctx): string {
  const c = constraintsOf(node);
  const pattern = typeof node['pattern'] === 'string' ? (node['pattern'] as string) : null;
  const examples = node['examples'];
  const title = typeof node['title'] === 'string' ? (node['title'] as string) : property;

  const candidates: (string | null)[] = [
    domainValue(property, ctx),
    c.format === 'date' ? ctx.contentDate.toISOString().slice(0, 10) : null,
    c.format === 'date-time' ? iso(ctx.currentSitting.start) : null,
    c.format === 'time' ? `${ctx.currentSitting.start.toISOString().slice(11, 19)}Z` : null,
    pattern ? satisfyPattern(pattern, ctx) : null,
    Array.isArray(examples) && examples.length > 0 ? String(examples[0]) : null,
    `${TEST_SENTINEL} ${title}`,
    // Last resorts, for fields that only constrain length.
    'Not specified',
    'X'.repeat(Math.max(c.minLength, 1)),
  ];

  for (const candidate of candidates) {
    if (candidate === null) continue;
    const fitted = fit(candidate, c);
    if (satisfies(fitted, c)) return fitted;
  }

  return c.minLength > 0 ? 'X'.repeat(c.minLength) : '';
}

/* ---------------------------------------------------------------- entry point */

export function schemaFileFor(listType: string): string {
  return SCHEMA_FOR_LIST_TYPE[listType] ?? 'master_schema.json';
}

export function schemaFor(listType: string): JsonSchema {
  const file = schemaFileFor(listType);
  const schema = SCHEMAS[file];
  if (!schema) throw new Error(`no vendored schema ${file} for list type ${listType}`);
  return schema;
}

export interface GeneratedPayload {
  payload: unknown;
  schemaFile: string;
  venue: Venue;
  contentDate: Date;
}

export function generatePayload(options: GenerateOptions): GeneratedPayload {
  const { listType, rng } = options;
  const jurisdiction = jurisdictionFor(listType);
  const contentDate = options.contentDate ?? new Date();
  const venue = options.venue ?? pickVenue(rng, jurisdiction);
  const schema = schemaFor(listType);

  const ctx: Ctx = {
    rng,
    listType,
    jurisdiction,
    venue,
    contentDate,
    size: options.size ?? 'typical',
    root: schema,
    depth: 0,
    currentSitting: sittingWindow(rng, contentDate),
  };

  const payload = generateNode(schema, '', ctx);

  // Marks every generated artefact as simulator output: a generated court list
  // must never be mistakable for a real one. Skipped where the schema would
  // reject the extra key -- validity wins, and the sentinel case names and
  // synthetic venues still make the origin obvious.
  if (
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && schema['additionalProperties'] !== false
  ) {
    (payload as Record<string, unknown>)['provenance'] = PROVENANCE;
  }

  return { payload, schemaFile: schemaFileFor(listType), venue, contentDate };
}
