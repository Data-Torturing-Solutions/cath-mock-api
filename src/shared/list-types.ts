/**
 * The list type enum, vendored from HMCTS `pip-data-models`.
 *
 * Never hand-maintain this -- HMCTS add list types without notice. Re-run
 * `npm run refresh` to regenerate vendor/list-types.json from the real source.
 */
import vendored from '../../vendor/list-types.json';

export interface ListTypeInfo {
  name: string;
  friendlyName: string;
}

export const LIST_TYPES: readonly ListTypeInfo[] = vendored.listTypes;

export const LIST_TYPE_NAMES: readonly string[] = LIST_TYPES.map((lt) => lt.name);

const LIST_TYPE_SET = new Set(LIST_TYPE_NAMES);

export function isKnownListType(value: unknown): value is string {
  return typeof value === 'string' && LIST_TYPE_SET.has(value);
}

const FRIENDLY = new Map(LIST_TYPES.map((lt) => [lt.name, lt.friendlyName]));

export function friendlyName(listType: string): string {
  return FRIENDLY.get(listType) ?? listType;
}

export const LIST_TYPE_SOURCE = vendored.source;
