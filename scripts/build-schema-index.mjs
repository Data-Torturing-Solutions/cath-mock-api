/**
 * Generates `src/shared/generator/schemas.ts` -- a static barrel of the 42
 * vendored schemas plus the list-type -> schema mapping.
 *
 * Static imports rather than a dynamic read because this has to bundle into a
 * Worker, where there is no filesystem.
 *
 * Usage: node scripts/build-schema-index.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const schemaDir = join(root, 'vendor', 'schemas');
const listTypes = JSON.parse(readFileSync(join(root, 'vendor', 'list-types.json'), 'utf8')).listTypes;

const files = readdirSync(schemaDir).filter((f) => f.endsWith('.json')).sort();

const identifier = (file) =>
  file.replace(/\.json$/, '').replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));

/** `CIVIL_DAILY_CAUSE_LIST` -> `civil_daily_cause_list` */
const slugOf = (listType) => listType.toLowerCase();

/** Strips the `non-strategic__` prefix we added when flattening the directory. */
const bareName = (file) => file.replace(/^non-strategic__/, '').replace(/\.json$/, '');

/**
 * HMCTS publish one schema per *family*, not one per list type: every regional
 * SSCS list shares `sscs_daily_hearing_list`, every ChD/KB cause list shares
 * `common_kb_chd_daily_cause_list`, and so on. Filename matching alone finds
 * only the ~30 list types that happen to have a schema named after them, so
 * the families are declared here. Order matters -- first match wins.
 */
const FAMILY_RULES = [
  [/^SJP_(DELTA_)?PUBLIC_LIST$/, 'single_justice_procedure_public.json'],
  [/^SJP_(DELTA_)?PRESS_(LIST|REGISTER)$/, 'single_justice_procedure_press.json'],
  [/^UT_IAC_JR_LONDON_/, 'non-strategic__ut_iac_judicial_reviews_london_daily_hearing_list.json'],
  [/^UT_IAC_JR_/, 'non-strategic__ut_iac_judicial_reviews_daily_hearing_list.json'],
  [/^UT_T_AND_CC_/, 'non-strategic__ut_tax_and_chancery_chamber_daily_hearing_list.json'],
  [/^UT_LC_/, 'non-strategic__ut_lands_chamber_daily_hearing_list.json'],
  [/^UT_AAC_/, 'non-strategic__ut_administrative_appeals_chamber_daily_hearing_list.json'],
  [/^SSCS_.*_DAILY_HEARING_LIST$/, 'non-strategic__sscs_daily_hearing_list.json'],
  [/^FTT_TAX_/, 'non-strategic__ftt-tax-chamber-tribunal-weekly-hearing-list.json'],
  [/^FTT_LR_/, 'non-strategic__ftt-land-registry-tribunal-weekly-hearing-list.json'],
  [/^(FTT_)?RPT_/, 'non-strategic__ftt-residential-property-tribunal-weekly-hearing-list.json'],
  [/^INTERIM_APPLICATIONS_CHD_/, 'non-strategic__interim_applications_chancery_division_daily_cause_list.json'],
  [/^CIC_/, 'non-strategic__cic_weekly_hearing_list.json'],
  // Everything in the Business and Property Courts shares one flat schema.
  [/(_CHD_|_KB_|^ADMIRALTY_|^BUSINESS_LIST_|^CHANCERY_APPEALS_|^COMMERCIAL_COURT_|^COMPANIES_WINDING_UP_|^COMPETITION_LIST_|^FINANCIAL_LIST_|^INSOLVENCY_AND_COMPANIES_COURT_|^INTELLECTUAL_PROPERTY_|^PATENTS_COURT_|^PENSIONS_LIST_|^PROPERTY_TRUSTS_PROBATE_|^REVENUE_LIST_|^TECHNOLOGY_AND_CONSTRUCTION_|^CIRCUIT_COMMERCIAL_|^BUSINESS_AND_PROPERTY_)/,
    'non-strategic__common_kb_chd_daily_cause_list.json'],
  // The remaining non-strategic lists share the common flat cause list.
  [/^(POAC_|PAAC_|MENTAL_HEALTH_|CARE_STANDARDS_|PRIMARY_HEALTH_|COUNTY_COURT_LONDON_|CIVIL_COURTS_RCJ_|COURT_OF_APPEAL_CRIMINAL_|FAMILY_DIVISION_HIGH_COURT_|KINGS_BENCH_|MAYOR_AND_CITY_|PCOL_|HIGH_COURT_|.*_ADMINISTRATIVE_COURT_)/,
    'non-strategic__common_ns_daily_cause_list.json'],
];

/**
 * Legacy Crown lists (CROWN_DAILY_LIST and friends) are the honest gap: HMCTS
 * removed their schemas when the PDDA replacements landed, and the PDDA shape
 * is genuinely different. They fall back to master_schema, which is the
 * courtLists shape they used.
 */
const FALLBACK = 'master_schema.json';

function schemaFor(listType) {
  const slug = slugOf(listType);
  const candidates = [
    `${slug}.json`,
    `non-strategic__${slug}.json`,
    `non-strategic__${slug.replace(/_/g, '-')}.json`,
  ];
  for (const candidate of candidates) {
    if (files.includes(candidate)) return candidate;
  }
  // Some schemas drop a qualifier the enum keeps, e.g.
  // SSCS_DAILY_LIST_ADDITIONAL_HEARINGS -> sscs_daily_list.
  const exact = files.find((f) => bareName(f) === slug);
  if (exact) return exact;

  const prefixMatch = files
    .filter((f) => slug.startsWith(bareName(f)) && bareName(f).length > 8)
    .sort((a, b) => bareName(b).length - bareName(a).length)[0];
  if (prefixMatch) return prefixMatch;

  for (const [pattern, file] of FAMILY_RULES) {
    if (pattern.test(listType)) return files.includes(file) ? file : null;
  }

  return null;
}

const mapping = {};
const fallbacks = [];
let mapped = 0;
for (const { name } of listTypes) {
  const file = schemaFor(name);
  if (file) {
    mapped++;
    mapping[name] = file;
  } else {
    fallbacks.push(name);
    mapping[name] = FALLBACK;
  }
}

const lines = [
  '/**',
  ' * Generated by scripts/build-schema-index.mjs -- do not edit by hand.',
  ' *',
  ` * ${files.length} schemas vendored from hmcts/pip-data-management,`,
  ` * ${mapped} of ${listTypes.length} list types mapped to one.`,
  ' */',
  '/* eslint-disable */',
  '',
];

for (const file of files) {
  lines.push(`import ${identifier(file)} from '../../../vendor/schemas/${file}';`);
}

lines.push('');
lines.push('export type JsonSchema = Record<string, unknown>;');
lines.push('');
lines.push('export const SCHEMAS: Record<string, JsonSchema> = {');
for (const file of files) {
  lines.push(`  ${JSON.stringify(file)}: ${identifier(file)} as JsonSchema,`);
}
lines.push('};');
lines.push('');
lines.push('/** The vendored schema each list type validates against. */');
lines.push('export const SCHEMA_FOR_LIST_TYPE: Record<string, string> = {');
for (const [listType, file] of Object.entries(mapping)) {
  lines.push(`  ${JSON.stringify(listType)}: ${JSON.stringify(file)},`);
}
lines.push('};');
lines.push('');
lines.push('/**');
lines.push(' * List types with no schema of their own in pip-data-management, generated');
lines.push(` * against ${FALLBACK} instead. Mostly the legacy Crown lists that the PDDA`);
lines.push(' * variants replaced.');
lines.push(' */');
lines.push('export const LIST_TYPES_WITHOUT_OWN_SCHEMA: string[] = [');
for (const listType of fallbacks) lines.push(`  ${JSON.stringify(listType)},`);
lines.push('];');
lines.push('');

writeFileSync(join(root, 'src', 'shared', 'generator', 'schemas.ts'), lines.join('\n'));

console.log(`wrote schemas.ts: ${files.length} schemas, ${mapped}/${listTypes.length} list types mapped`);
if (fallbacks.length) {
  console.log(`  falling back to ${FALLBACK} (${fallbacks.length}): ${fallbacks.join(', ')}`);
}
const unused = files.filter((f) => !Object.values(mapping).includes(f));
if (unused.length) console.log(`  unused schemas (${unused.length}): ${unused.join(', ')}`);
