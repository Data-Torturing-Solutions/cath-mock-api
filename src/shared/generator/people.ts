/**
 * Synthetic people.
 *
 * Court lists carry the names of real defendants, parties and judges. A
 * generator that produced plausible British names next to plausible criminal
 * charges would be manufacturing defamatory-looking records about people who
 * may well exist -- and once that leaks into a bucket, an index or a
 * screenshot it is a real problem, not a theoretical one.
 *
 * So: the surname pool is deliberately, obviously fake; every case name carries
 * a sentinel prefix; and synthetic personal names are never attached to
 * criminal charges. Party names in civil and commercial contexts use invented
 * companies instead, which reads realistically without naming anybody.
 */
import type { Rng } from './random.js';

/** Prefixed onto every generated case name. Grep for it before publishing anything. */
export const TEST_SENTINEL = '[TEST]';

/** Recorded in every generated payload so simulator data is never mistaken for real. */
export const PROVENANCE = 'SIMULATOR';

/**
 * Not a census list. Every entry is either a coined word or an obvious
 * placeholder, so no generated name can collide with a real person.
 */
const SURNAMES = [
  'Testerton', 'Fakeworth', 'Placeholder-Smith', 'Mockley', 'Dummerdale',
  'Sampleford', 'Exampleton', 'Fixtureby', 'Stubbington', 'Loremhurst',
  'Ipsumfield', 'Nullingham', 'Voidmarch', 'Sandboxe', 'Simulacre',
  'Dryrunn', 'Testcastle', 'Fabricant', 'Notreal-Jones', 'Synthwood',
];

const FORENAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa',
];

/** Titles are real -- they are job descriptions, not identities. */
const JUDICIAL_TITLES = [
  'District Judge', 'District Judge (Magistrates\' Courts)', 'HHJ', 'Recorder',
  'Employment Judge', 'Tribunal Judge', 'Deputy District Judge', 'Circuit Judge',
  'Judge', 'Regional Employment Judge', 'Deputy Upper Tribunal Judge',
];

const TRIBUNAL_MEMBER_TITLES = ['Mr', 'Mrs', 'Ms', 'Dr'];

/** Coined company names -- none of these are trading entities. */
const COMPANY_STEMS = [
  'Acme', 'Beta', 'Cygnet', 'Delphi', 'Ember', 'Fathom', 'Granite', 'Harrow',
  'Ionic', 'Juniper', 'Kestrel', 'Lumen', 'Meridian', 'Nimbus', 'Orbit',
  'Pinnacle', 'Quarry', 'Redwood', 'Summit', 'Trellis',
];

const COMPANY_SUFFIXES = [
  'Holdings Ltd', 'Trading Ltd', 'Group plc', 'Services Ltd', 'Industries Ltd',
  'Partners LLP', 'Developments Ltd', 'Logistics Ltd', 'Capital Ltd',
];

export function judicialName(rng: Rng): string {
  return `${rng.pick(JUDICIAL_TITLES)} ${rng.pick(SURNAMES)}`;
}

export function tribunalMemberName(rng: Rng): string {
  return `${rng.pick(TRIBUNAL_MEMBER_TITLES)} ${rng.pick(SURNAMES)}`;
}

export function companyName(rng: Rng): string {
  return `${rng.pick(COMPANY_STEMS)} ${rng.pick(COMPANY_SUFFIXES)}`;
}

export function personName(rng: Rng): string {
  return `${rng.pick(FORENAMES)} ${rng.pick(SURNAMES)}`;
}

export type Jurisdiction = 'civil' | 'family' | 'crime' | 'tribunal';

/**
 * Case names, always sentinel-prefixed.
 *
 * Criminal lists get a coined *company* as the defendant rather than a
 * synthetic person, because "R v <plausible person> -- burglary" is exactly the
 * artefact this module exists to avoid producing.
 */
export function caseName(rng: Rng, jurisdiction: Jurisdiction): string {
  switch (jurisdiction) {
    case 'crime':
      return `${TEST_SENTINEL} R v ${companyName(rng)}`;
    case 'family':
      return `${TEST_SENTINEL} Re: ${rng.pick(SURNAMES)} (a test fixture)`;
    case 'tribunal':
      return `${TEST_SENTINEL} ${companyName(rng)} v ${companyName(rng)}`;
    case 'civil':
    default:
      return `${TEST_SENTINEL} ${companyName(rng)} v ${companyName(rng)}`;
  }
}

export function partyName(rng: Rng): string {
  return `${TEST_SENTINEL} ${companyName(rng)}`;
}
