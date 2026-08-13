/** The contract types from the CaTH API requirements, section "Metadata". */

export const SENSITIVITIES = ['PUBLIC', 'PRIVATE', 'CLASSIFIED'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const LANGUAGES = ['ENGLISH', 'WELSH', 'BI_LINGUAL'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface PublicationMetadata {
  publicationId: string;
  listType: string;
  locationName: string;
  contentDate: string;
  sensitivity: Sensitivity;
  language: Language;
  displayFrom: string;
  displayTo: string;
  /**
   * CaTH is explicitly allowed to add fields without notice, so anything we do
   * not recognise is carried through rather than rejected.
   */
  [extra: string]: unknown;
}

/** What arrived on the wire: JSON payload, flat file, or neither. */
export type ArtefactKind = 'json' | 'file' | 'none';

export type PublicationState = 'active' | 'deleted' | 'expired';

export interface PublicationRow {
  publication_id: string;
  list_type: string;
  location_name: string;
  content_date: string;
  sensitivity: Sensitivity;
  language: Language;
  display_from: string;
  display_to: string;
  artefact_kind: ArtefactKind;
  r2_key: string | null;
  file_mime: string | null;
  file_name: string | null;
  content_hash: string | null;
  version: number;
  state: PublicationState;
  created_via: 'POST' | 'PUT';
  first_seen_at: string;
  last_seen_at: string;
  deleted_at: string | null;
  auth_used: number;
}

/**
 * The five fields CaTH uses to decide supersession. Provenance and location ID
 * are NOT in the metadata block, so this is a secondary index only -- we key on
 * publicationId. See README "What we cannot replicate".
 */
export interface SupersedeTuple {
  listType: string;
  locationName: string;
  language: Language;
  contentDate: string;
}

/** Content types the `file` part is allowed to carry. */
export const FLAT_FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  htm: 'text/html',
  html: 'text/html',
};
