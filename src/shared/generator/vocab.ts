/**
 * Domain vocabulary. This is what separates a payload that validates from a
 * payload that looks like a court list.
 */
import venuesData from '../../../vendor/venues.json';
import type { Rng } from './random.js';
import type { Jurisdiction } from './people.js';

export interface Venue {
  slug: string;
  name: string;
  types: string[];
  areasOfLaw: string[];
  address: { lines: string[]; town: string; county: string; postCode: string } | null;
  dxNumber: string | null;
}

/** Real venues, real addresses -- from Find a Court or Tribunal under OGL v3. */
export const VENUES: Venue[] = venuesData.venues as Venue[];

export function pickVenue(rng: Rng, jurisdiction?: Jurisdiction): Venue {
  if (!jurisdiction) return rng.pick(VENUES);

  const wanted: Record<Jurisdiction, RegExp> = {
    civil: /civil|county/i,
    family: /family/i,
    crime: /crown|magistrate/i,
    tribunal: /tribunal/i,
  };
  const matching = VENUES.filter(
    (v) => wanted[jurisdiction].test(v.name) || v.types.some((t) => wanted[jurisdiction].test(t)),
  );
  return matching.length > 0 ? rng.pick(matching) : rng.pick(VENUES);
}

/**
 * Courtroom names. Mostly numbered, with the real-world oddities that make a
 * list look like it came from a building rather than a loop.
 */
export function courtRoomName(rng: Rng): string {
  return rng.weighted([
    [`Courtroom ${rng.int(1, 12)}`, 60],
    [`Court ${rng.int(1, 12)}`, 20],
    ['Court 3 (Annexe)', 4],
    ['Remote Hearing Room', 6],
    ['Video Hearing Room 1', 3],
    ['Judge\'s Chambers', 3],
    [`Hearing Room ${rng.int(1, 6)}`, 4],
  ]);
}

export const CHANNELS = ['In person', 'Video hearing', 'Telephone'] as const;

export function channel(rng: Rng): string {
  return rng.weighted([
    ['In person', 60],
    ['Video hearing', 30],
    ['Telephone', 10],
  ]);
}

const HEARING_TYPES: Record<Jurisdiction, readonly string[]> = {
  civil: [
    'Directions', 'Trial', 'Case Management', 'Application', 'Small Claim Hearing',
    'Fast Track Trial', 'Costs and Case Management Conference', 'Disposal',
  ],
  family: [
    'First Hearing Dispute Resolution Appointment', 'Directions', 'Final Hearing',
    'Case Management', 'Fact Finding', 'Interim Care Order',
  ],
  crime: [
    'Trial', 'Sentence', 'Plea and Trial Preparation Hearing', 'Application',
    'Pre-Trial Review', 'Committal for Sentence', 'Appeal',
  ],
  tribunal: [
    'Preliminary Hearing', 'Final Hearing', 'Case Management', 'Remedy Hearing',
    'Directions', 'Substantive Hearing',
  ],
};

export function hearingType(rng: Rng, jurisdiction: Jurisdiction): string {
  return rng.pick(HEARING_TYPES[jurisdiction]);
}

export const CASE_TYPES = [
  'Civil', 'Family', 'Crime', 'Tribunal', 'Appeal', 'Insolvency', 'Employment',
];

/**
 * The shape of a sitting day: business starts at 10:00, resumes at 14:00, and
 * the tail is short. Uniform random start times are the giveaway that a list
 * was generated.
 */
export function sittingWindow(rng: Rng, contentDate: Date): { start: Date; end: Date } {
  const [hour, minute] = rng.weighted<[number, number]>([
    [[10, 0], 40],
    [[10, 30], 12],
    [[11, 0], 8],
    [[12, 0], 4],
    [[14, 0], 22],
    [[14, 30], 8],
    [[15, 0], 4],
    [[9, 30], 2],
  ]);

  const start = new Date(contentDate);
  start.setUTCHours(hour, minute, 0, 0);

  const durationMinutes = rng.weighted([
    [30, 20],
    [60, 30],
    [90, 20],
    [120, 15],
    [180, 10],
    [360, 5],
  ]);

  return { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
}

/**
 * Case numbers by jurisdiction. Wrong-shaped case numbers are the fastest way
 * to make test data look fake to anyone who reads court lists for a living.
 */
export function caseNumber(rng: Rng, jurisdiction: Jurisdiction): string {
  const digits = (n: number) =>
    Array.from({ length: n }, () => rng.int(0, 9)).join('');
  const letter = () => String.fromCharCode(65 + rng.int(0, 25));

  switch (jurisdiction) {
    // County court claim number, e.g. 24YX01234
    case 'civil':
      return `${digits(2)}${letter()}${letter()}${digits(5)}`;
    // Family case number, e.g. ZC24C00123
    case 'family':
      return `${letter()}${letter()}${digits(2)}${letter()}${digits(5)}`;
    // Crown court case number (URN-like), e.g. 01AB1234524
    case 'crime':
      return `${digits(2)}${letter()}${letter()}${digits(7)}`;
    // Employment tribunal, e.g. 1234/2025
    case 'tribunal':
    default:
      return `${digits(4)}/${digits(4)}`;
  }
}

/** Crime uses a URN rather than a case number in several list types. */
export function caseUrn(rng: Rng): string {
  const digits = (n: number) => Array.from({ length: n }, () => rng.int(0, 9)).join('');
  const letter = () => String.fromCharCode(65 + rng.int(0, 25));
  return `${digits(2)}${letter()}${letter()}${digits(7)}`;
}

export const CASE_SEQUENCE_INDICATORS = ['1 of 2', '2 of 2', '1 of 3', '2 of 3', '3 of 3'];

export const REPORTING_RESTRICTIONS = [
  'Section 4(2) order in force',
  'Section 45 Youth Justice and Criminal Evidence Act 1999',
  'No reporting restrictions',
];

export const LISTING_NOTES = [
  'Not before 10:30',
  'Time estimate: 1 hour',
  'To be heard in private',
  'Part heard',
  'Floating',
];

/**
 * Which jurisdiction a list type belongs to, used to choose case number shapes
 * and hearing type vocabulary.
 */
export function jurisdictionFor(listType: string): Jurisdiction {
  if (/CROWN|MAGISTRATES|SJP|PDDA/.test(listType)) return 'crime';
  if (/FAMILY|COP_|ADOPTION/.test(listType)) return 'family';
  if (/^(ET|SSCS|IAC|UT_|FTT|RPT|GRC|CIC|CST|PHT|SIAC|SEND|AST|WPAFCC|MENTAL_HEALTH|CARE_STANDARDS|PRIMARY_HEALTH)/.test(listType)) {
    return 'tribunal';
  }
  return 'civil';
}
