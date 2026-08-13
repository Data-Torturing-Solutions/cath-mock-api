/**
 * Builds `vendor/venues.json` from Find a Court or Tribunal (FaCT).
 *
 * FaCT has no bulk export, so we sweep its postcode search across England and
 * Wales and dedupe by slug. Real venue names and real addresses matter here --
 * see the README's realism notes. People are never real; venues always are.
 *
 * Usage: node scripts/fetch-venues.mjs [out.json]
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] ?? fileURLToPath(new URL('../vendor/venues.json', import.meta.url));
const BASE = 'https://www.find-court-tribunal.service.gov.uk/search/results.json';

// A spread wide enough that the union covers essentially every venue: FaCT
// returns the nearest ~10 courts per area of law per postcode.
const POSTCODES = [
  'SW1A 1AA', 'E1 6AN', 'N1 9GU', 'SE1 9GF', 'W1D 3QU', 'CR0 1SR', 'HA1 1BE',
  'RM1 3AB', 'KT1 1EU', 'EN1 1AA', 'IG1 1BA', 'UB1 1AA', 'TW1 3AA',
  'B1 1BB', 'CV1 1AA', 'ST1 1AA', 'WV1 1AA', 'WR1 1AA', 'HR1 1AA', 'TF1 1AA',
  'M1 1AE', 'L1 1AA', 'PR1 2LL', 'BB1 1AA', 'BL1 1AA', 'OL1 1AA', 'WA1 1AA',
  'CH1 1AA', 'CW1 1AA', 'LA1 1AA', 'CA1 1AA',
  'LS1 1AA', 'S1 1AA', 'BD1 1AA', 'HD1 1AA', 'HX1 1AA', 'YO1 1AA', 'HU1 1AA',
  'DN1 1AA', 'HG1 1AA', 'TS1 1AA', 'NE1 1AA', 'SR1 1AA', 'DH1 1AA', 'DL1 1AA',
  'NG1 1AA', 'LE1 1AA', 'DE1 1AA', 'LN1 1AA', 'PE1 1AA', 'NN1 1AA',
  'NR1 3JA', 'IP1 1AA', 'CB1 1AA', 'CO1 1AA', 'CM1 1AA', 'SS1 1AA', 'SG1 1AA',
  'LU1 1AA', 'MK1 1AA', 'OX1 1AA', 'RG1 1AA', 'SL1 1AA', 'AL1 1AA',
  'BS1 1AA', 'BA1 1AA', 'GL1 1AA', 'SN1 1AA', 'SP1 1AA', 'TA1 1AA', 'EX1 1AA',
  'PL1 1AA', 'TQ1 1AA', 'TR1 1AA', 'DT1 1AA', 'BH1 1AA', 'SO14 0AA', 'PO1 1AA',
  'BN1 1AA', 'ME1 1AA', 'CT1 1AA', 'TN1 1AA', 'RH1 1AA', 'GU1 1AA',
  'CF10 1AA', 'SA1 1AA', 'NP20 1AA', 'LL30 1AA', 'LL57 1AA', 'SY23 1AA',
  'LD1 5AA', 'CF47 8AA', 'SA61 1AA', 'LL13 8AA',
];

const AREAS = ['', 'Crime', 'Civil', 'Family', 'Employment', 'Immigration', 'Social security'];

const byslug = new Map();
let requests = 0;
let failures = 0;

async function sweep(postcode, aol) {
  const url = new URL(BASE);
  url.searchParams.set('postcode', postcode);
  if (aol) url.searchParams.set('aol', aol);

  try {
    requests++;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'cath-mock-api reference-data build (opencourtdata.uk)' },
    });
    if (!res.ok) return;
    const courts = await res.json();
    if (!Array.isArray(courts)) return;

    for (const court of courts) {
      if (!court?.slug || !court?.name || court.displayed === false) continue;
      if (/^test[- ]/i.test(court.slug)) continue;
      if (byslug.has(court.slug)) continue;

      const visiting = (court.addresses ?? []).find((a) => /visit/i.test(a.type ?? ''))
        ?? (court.addresses ?? [])[0];

      byslug.set(court.slug, {
        slug: court.slug,
        name: court.name,
        types: court.types ?? [],
        areasOfLaw: (court.areas_of_law ?? []).map((a) => a.name).filter(Boolean),
        address: visiting
          ? {
            lines: visiting.address_lines ?? [],
            town: visiting.town ?? '',
            county: visiting.county ?? '',
            postCode: visiting.postcode ?? '',
          }
          : null,
        dxNumber: court.dx_number ?? null,
      });
    }
  } catch (err) {
    failures++;
    if (failures < 5) console.warn(`  ! ${postcode} ${aol}: ${err.message}`);
  }
}

// Modest concurrency -- this is a live public service, not a load target.
const jobs = POSTCODES.flatMap((pc) => AREAS.map((aol) => [pc, aol]));
const CONCURRENCY = 6;

for (let i = 0; i < jobs.length; i += CONCURRENCY) {
  await Promise.all(jobs.slice(i, i + CONCURRENCY).map(([pc, aol]) => sweep(pc, aol)));
  process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, jobs.length)}/${jobs.length} searches, ${byslug.size} venues`);
}
process.stdout.write('\n');

const venues = [...byslug.values()]
  .filter((v) => v.address && v.address.postCode)
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      source: 'https://www.find-court-tribunal.service.gov.uk (Find a Court or Tribunal)',
      licence: 'Open Government Licence v3.0',
      count: venues.length,
      venues,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${venues.length} venues from ${requests} searches (${failures} failed) -> ${OUT}`);
