-- CaTH receiver storage.
--
-- publications  : current state, keyed on the only identifier CaTH guarantees.
-- deliveries    : every request we were sent, including retries and rejects.
-- quarantine    : bodies we could not accept, kept so a 4xx never loses data.

CREATE TABLE IF NOT EXISTS publications (
  publication_id   TEXT PRIMARY KEY,               -- UUID from metadata
  list_type        TEXT NOT NULL,
  location_name    TEXT NOT NULL,
  content_date     TEXT NOT NULL,                  -- ISO 8601
  sensitivity      TEXT NOT NULL,                  -- PUBLIC|PRIVATE|CLASSIFIED
  language         TEXT NOT NULL,                  -- ENGLISH|WELSH|BI_LINGUAL
  display_from     TEXT NOT NULL,
  display_to       TEXT NOT NULL,
  artefact_kind    TEXT NOT NULL,                  -- 'json' | 'file' | 'none'
  r2_key           TEXT,                           -- null when artefact_kind='none'
  file_mime        TEXT,
  file_name        TEXT,
  content_hash     TEXT,                           -- identity of the current version
  version          INTEGER NOT NULL DEFAULT 1,     -- bumped when content changes
  state            TEXT NOT NULL DEFAULT 'active', -- active|deleted|expired
  created_via      TEXT NOT NULL DEFAULT 'POST',   -- POST|PUT (PUT = we never saw the POST)
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  deleted_at       TEXT,
  auth_used        INTEGER NOT NULL DEFAULT 0      -- 1 if a valid bearer token was presented
);

-- CaTH decides supersession on provenance, type, location ID, language and
-- content date. Provenance and location ID are not in the metadata block, so
-- this index is a secondary lookup only -- never a key.
CREATE INDEX IF NOT EXISTS idx_supersede ON publications(list_type, location_name, language, content_date);
CREATE INDEX IF NOT EXISTS idx_display   ON publications(display_from, display_to);
CREATE INDEX IF NOT EXISTS idx_state     ON publications(state, list_type);

-- Full audit trail. This table is the point of the exercise: when something
-- goes wrong after onboarding, it is the evidence.
CREATE TABLE IF NOT EXISTS deliveries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT,
  method         TEXT NOT NULL,                    -- GET|POST|PUT|DELETE
  path           TEXT,
  received_at    TEXT NOT NULL,
  status_sent    INTEGER NOT NULL,
  auth_used      INTEGER NOT NULL DEFAULT 0,
  validation_ok  INTEGER,
  outcome        TEXT,                             -- created|unchanged|superseded|deleted|rejected|...
  error          TEXT,
  raw_headers    TEXT,
  duration_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deliveries_pub ON deliveries(publication_id, received_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_at  ON deliveries(received_at);

-- Anything we returned a 4xx for. CaTH retries three times and then drops the
-- publication forever, so we keep the body regardless of the status we sent.
CREATE TABLE IF NOT EXISTS quarantine (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id    INTEGER,
  publication_id TEXT,
  received_at    TEXT NOT NULL,
  reason         TEXT NOT NULL,
  metadata_text  TEXT,
  r2_key         TEXT,                             -- raw payload/file bytes, when present
  resolved       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quarantine_at ON quarantine(received_at);
