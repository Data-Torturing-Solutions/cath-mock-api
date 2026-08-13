import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { LIST_TYPE_NAMES } from '../../src/shared/list-types.js';
import {
  Rng,
  SCHEMAS,
  TEST_SENTINEL,
  VENUES,
  generatePayload,
  generatePublication,
  schemaFileFor,
} from '../../src/shared/generator/index.js';
import { hasJavaOnlyPatterns, toEcmaSchema } from '../../src/shared/generator/schema-compat.js';
import { validateMetadata } from '../../src/shared/metadata.js';

/**
 * The schemas are draft 2020-12 and carry Java-flavoured regexes. `strict:
 * false` keeps Ajv from rejecting the vendored schemas themselves over
 * keywords it does not recognise -- we are validating our output against
 * HMCTS's schemas, not auditing HMCTS's schema style.
 */
function makeAjv(options: { validateSchema?: boolean } = {}) {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    validateFormats: true,
    // One vendored schema is itself invalid per the 2020-12 meta-schema (see
    // the "vendored schema compatibility" block below). We still want to
    // validate instances against it, so meta-validation is opt-in.
    validateSchema: options.validateSchema ?? false,
  });
  addFormats(ajv);
  return ajv;
}

// Compiling all 42 schemas takes long enough that recompiling per assertion
// dominates the suite.
const validators = new Map<string, ReturnType<ReturnType<typeof makeAjv>['compile']>>();

function compile(schemaFile: string) {
  const cached = validators.get(schemaFile);
  if (cached) return cached;

  const schema = SCHEMAS[schemaFile];
  if (!schema) throw new Error(`missing schema ${schemaFile}`);
  // Java-only regex syntax has to be rewritten first or Ajv cannot compile the
  // schema at all. See src/shared/generator/schema-compat.ts.
  const validate = makeAjv().compile(toEcmaSchema(schema));
  validators.set(schemaFile, validate);
  return validate;
}

describe('generated payloads validate against the real HMCTS schemas', () => {
  it('produces 100 valid CIVIL_DAILY_CAUSE_LIST payloads', () => {
    const validate = compile(schemaFileFor('CIVIL_DAILY_CAUSE_LIST'));
    const failures: string[] = [];

    for (let seed = 0; seed < 100; seed++) {
      const { payload } = generatePayload({
        listType: 'CIVIL_DAILY_CAUSE_LIST',
        rng: new Rng(`civil-${seed}`),
      });
      if (!validate(payload)) {
        failures.push(`seed ${seed}: ${makeAjv().errorsText(validate.errors)}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('produces valid payloads for every one of the list types', () => {
    const failures: string[] = [];

    for (const listType of LIST_TYPE_NAMES) {
      const validate = compile(schemaFileFor(listType));
      for (const size of ['minimal', 'typical', 'deep'] as const) {
        const { payload } = generatePayload({
          listType,
          rng: new Rng(`${listType}-${size}`),
          size,
        });
        if (!validate(payload)) {
          failures.push(`${listType} (${size}): ${makeAjv().errorsText(validate.errors?.slice(0, 3))}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('covers all 42 vendored schemas', () => {
    const used = new Set(LIST_TYPE_NAMES.map(schemaFileFor));
    expect(used.size).toBe(Object.keys(SCHEMAS).length);
  });
});

describe('payload shape', () => {
  it('walks the full document/venue/courtLists tree down to a case', () => {
    const { payload } = generatePayload({
      listType: 'CIVIL_DAILY_CAUSE_LIST',
      rng: new Rng('deep-tree'),
      size: 'deep',
    });

    const root = payload as Record<string, any>;
    expect(root['document']).toBeDefined();
    expect(root['venue']).toBeDefined();

    const courtRoom = root['courtLists'][0].courtHouse.courtRoom[0];
    const sitting = courtRoom.session[0].sittings[0];
    const hearingCase = sitting.hearing[0].case[0];

    expect(typeof hearingCase.caseNumber).toBe('string');
    expect(hearingCase.caseName ?? '').toContain(TEST_SENTINEL);
  });

  it('is deterministic for a given seed', () => {
    const a = generatePayload({ listType: 'ET_DAILY_LIST', rng: new Rng('same') });
    const b = generatePayload({ listType: 'ET_DAILY_LIST', rng: new Rng('same') });
    expect(JSON.stringify(a.payload)).toBe(JSON.stringify(b.payload));
  });

  it('generates a nearly-empty list as well as a deep one', () => {
    const minimal = generatePayload({
      listType: 'CIVIL_DAILY_CAUSE_LIST',
      rng: new Rng('small'),
      size: 'minimal',
    });
    const deep = generatePayload({
      listType: 'CIVIL_DAILY_CAUSE_LIST',
      rng: new Rng('small'),
      size: 'deep',
    });
    expect(JSON.stringify(minimal.payload).length).toBeLessThan(
      JSON.stringify(deep.payload).length,
    );
  });

  it('clusters sitting start times at 10:00 and 14:00 rather than uniformly', () => {
    const starts: number[] = [];
    for (let seed = 0; seed < 60; seed++) {
      const { payload } = generatePayload({
        listType: 'CIVIL_DAILY_CAUSE_LIST',
        rng: new Rng(`times-${seed}`),
        size: 'deep',
      });
      for (const list of (payload as any).courtLists ?? []) {
        for (const room of list.courtHouse?.courtRoom ?? []) {
          for (const session of room.session ?? []) {
            for (const sitting of session.sittings ?? []) {
              if (typeof sitting.sittingStart === 'string') {
                starts.push(Number(sitting.sittingStart.slice(11, 13)));
              }
            }
          }
        }
      }
    }

    expect(starts.length).toBeGreaterThan(50);
    const morningOrAfternoonPeak = starts.filter((h) => h === 10 || h === 14).length;
    expect(morningOrAfternoonPeak / starts.length).toBeGreaterThan(0.5);
  });
});

describe('people are synthetic, venues are real', () => {
  it('uses real court venues with real addresses', () => {
    expect(VENUES.length).toBeGreaterThan(300);
    for (const venue of VENUES.slice(0, 50)) {
      expect(venue.address?.postCode).toMatch(/[A-Z]{1,2}\d/i);
    }
  });

  it('sentinel-prefixes every generated case name', () => {
    const names: string[] = [];
    for (let seed = 0; seed < 25; seed++) {
      const { payload } = generatePayload({
        listType: 'CIVIL_DAILY_CAUSE_LIST',
        rng: new Rng(`civil-names-${seed}`),
        size: 'typical',
      });
      collect(payload, ['caseName', 'caseTitle'], names);
    }
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toContain(TEST_SENTINEL);
  });

  it('never puts a synthetic person next to a criminal charge', () => {
    const names: string[] = [];
    for (let seed = 0; seed < 25; seed++) {
      const { payload } = generatePayload({
        listType: 'MAGISTRATES_STANDARD_LIST',
        rng: new Rng(`mags-${seed}`),
        size: 'typical',
      });
      collect(payload, ['caseName', 'caseTitle'], names);
    }
    // Criminal case names use coined companies, so "R v <person>" never occurs.
    for (const name of names) {
      if (name.startsWith(`${TEST_SENTINEL} R v `)) {
        expect(name).toMatch(/(Ltd|plc|LLP)$/);
      }
    }
  });

  it('marks every PDDA defendant record as simulator data', () => {
    const offences: string[] = [];
    const birthDates: string[] = [];

    for (const listType of ['CROWN_DAILY_PDDA_LIST', 'CROWN_FIRM_PDDA_LIST', 'CROWN_WARNED_PDDA_LIST']) {
      for (let seed = 0; seed < 15; seed++) {
        const { payload } = generatePayload({
          listType,
          rng: new Rng(`pdda-${listType}-${seed}`),
          size: 'deep',
        });
        collect(payload, ['OffenceStatement', 'Charges'], offences);
        collect(payload, ['DateOfBirth', 'BirthDate'], birthDates);
      }
    }

    // The Crown PDDA lists are the only schemas carrying defendant personal
    // details next to charges, so they get checked explicitly.
    expect(offences.length).toBeGreaterThan(0);
    for (const offence of offences) expect(offence).toContain(TEST_SENTINEL);
    for (const dob of birthDates) expect(dob).toBe('1990-01-01');
  });
});

function collect(node: unknown, keys: string[], into: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, keys, into);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (keys.includes(key) && typeof value === 'string' && value !== '') into.push(value);
    else collect(value, keys, into);
  }
}

/**
 * Two defects in the schemas HMCTS publish. Both are pinned here rather than
 * quietly worked around, so `npm run refresh` tells us the day they are fixed
 * (or the day a new one appears).
 */
describe('vendored schema compatibility', () => {
  it('pins the HMCTS schemas whose patterns are not valid ECMA-262', () => {
    const affected = Object.entries(SCHEMAS)
      .filter(([, schema]) => hasJavaOnlyPatterns(schema))
      .map(([file]) => file)
      .sort();

    // `(?s)` inline flags and `\-` identity escapes: legal in Java, rejected
    // by every JavaScript regex engine. As shipped, these three schemas cannot
    // be compiled by a JS validator at all.
    expect(affected).toEqual([
      'magistrates_public_list.json',
      'magistrates_standard_list.json',
      'master_schema.json',
    ]);

    for (const file of affected) {
      expect(() => makeAjv().compile(SCHEMAS[file]!)).toThrow();
      expect(() => makeAjv().compile(toEcmaSchema(SCHEMAS[file]!))).not.toThrow();
    }
  });

  it('pins the HMCTS schemas that fail the 2020-12 meta-schema', () => {
    const invalid = Object.entries(SCHEMAS)
      .filter(([, schema]) => {
        try {
          makeAjv({ validateSchema: true }).compile(toEcmaSchema(schema));
          return false;
        } catch {
          return true;
        }
      })
      .map(([file]) => file)
      .sort();

    // cop_daily_cause_list declares `"examples": "<a string>"` where the
    // meta-schema requires an array. The generator tolerates it; a stricter
    // consumer would not.
    expect(invalid).toEqual(['cop_daily_cause_list.json']);
  });
});

describe('complete publications', () => {
  it('produces metadata the receiver accepts', () => {
    for (let seed = 0; seed < 200; seed++) {
      const { metadata } = generatePublication({ seed: `pub-${seed}` });
      const result = validateMetadata(metadata);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it('produces flat files with the right shape and a {uuid}.{ext} name', () => {
    const { metadata, file, payload } = generatePublication({
      seed: 'flat-file',
      artefact: 'file',
    });
    expect(payload).toBeNull();
    expect(file).not.toBeNull();
    expect(file!.name).toBe(`${metadata.publicationId}.${file!.name.split('.').pop()}`);
    expect(['application/pdf', 'text/csv', 'text/html']).toContain(file!.mime);
    expect(file!.bytes.byteLength).toBeGreaterThan(100);
  });

  it('produces a structurally valid PDF', () => {
    const { file } = generatePublication({
      seed: 'pdf-only',
      artefact: 'file',
      listType: 'CROWN_DAILY_PDDA_LIST',
    });
    const text = new TextDecoder().decode(
      file!.mime === 'application/pdf' ? file!.bytes : new Uint8Array(),
    );
    if (file!.mime === 'application/pdf') {
      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text).toContain('/Type /Catalog');
      expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    }
  });

  it('gives Welsh venues Welsh and bilingual publications', () => {
    const languages = new Set<string>();
    for (let seed = 0; seed < 400; seed++) {
      languages.add(generatePublication({ seed: `lang-${seed}` }).metadata.language);
    }
    expect(languages.has('ENGLISH')).toBe(true);
    expect(languages.has('WELSH') || languages.has('BI_LINGUAL')).toBe(true);
  });
});
