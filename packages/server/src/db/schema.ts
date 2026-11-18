/**
 * Tables that `reindex --from-raw` keeps. Everything else in DERIVED_TABLES is
 * dropped and rebuilt from the raw archive.
 */
export const KEPT_TABLES = [
  "meta",
  "files",
  "tokens",
  "shapes",
  "shape_paths",
  "machines",
  "embedding_models",
  "enroll_requests",
] as const;

export const DERIVED_TABLES = [
  "chunks_fts",
  "chunks",
  "messages",
  "records",
  "sessions",
  "quarantine",
  "drift_events",
  "yield_stats",
  "alert_outbox",
  "query_log",
] as const;

export const SCHEMA_VERSION = 1;

export const KEPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  machine TEXT NOT NULL,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  parsed_offset INTEGER NOT NULL DEFAULT 0,
  parser_state TEXT,
  harness_version TEXT,
  lines_read INTEGER NOT NULL DEFAULT 0,
  messages_produced INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (machine, source, path, generation)
);

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('ingest', 'search', 'admin')),
  machine TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS shapes (
  source TEXT NOT NULL,
  hash TEXT NOT NULL,
  discriminator TEXT NOT NULL,
  classification TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  harness_version TEXT,
  sample_ref TEXT,
  PRIMARY KEY (source, hash)
);
CREATE INDEX IF NOT EXISTS shapes_discriminator ON shapes (source, discriminator);

CREATE TABLE IF NOT EXISTS shape_paths (
  source TEXT NOT NULL,
  discriminator TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (source, discriminator, path)
);

CREATE TABLE IF NOT EXISTS machines (
  machine TEXT PRIMARY KEY,
  collector_version TEXT,
  last_heartbeat_at TEXT,
  last_ingest_at TEXT,
  sources TEXT
);

CREATE TABLE IF NOT EXISTS embedding_models (
  slug TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  query_prefix TEXT NOT NULL DEFAULT '',
  document_prefix TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS enroll_requests (
  id INTEGER PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  machine TEXT NOT NULL,
  hostname TEXT,
  platform TEXT,
  collector_version TEXT,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS enroll_requests_expires ON enroll_requests (expires_at);
`;

export const DERIVED_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  machine TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'subagent', 'guardian')),
  project_path TEXT,
  git_branch TEXT,
  title TEXT,
  title_rank INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  parent_session_id TEXT,
  harness_version TEXT,
  file_id INTEGER REFERENCES files(id),
  chunk_dirty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at);
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions (parent_session_id);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  record_type TEXT NOT NULL,
  native_id TEXT,
  parent_native_id TEXT,
  timestamp TEXT,
  UNIQUE (file_id, byte_offset)
);
CREATE INDEX IF NOT EXISTS records_native ON records (native_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool_call', 'tool_result', 'reasoning')),
  text TEXT NOT NULL,
  record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  part INTEGER NOT NULL DEFAULT 0,
  tool_name TEXT,
  timestamp TEXT,
  UNIQUE (record_id, part)
);
CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id, ordinal);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  start_message_id INTEGER NOT NULL,
  end_message_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  part INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  timestamp TEXT
);
CREATE INDEX IF NOT EXISTS chunks_session ON chunks (session_id, ordinal, part);
CREATE INDEX IF NOT EXISTS chunks_hash ON chunks (text_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  reason TEXT NOT NULL,
  fingerprint TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (file_id, byte_offset)
);

CREATE TABLE IF NOT EXISTS drift_events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('breaking', 'additive', 'yield', 'version')),
  fingerprint TEXT NOT NULL,
  discriminator TEXT,
  harness_version TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  sample TEXT,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acked')),
  acked_at TEXT,
  UNIQUE (source, severity, fingerprint)
);

CREATE TABLE IF NOT EXISTS yield_stats (
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, day)
);

CREATE TABLE IF NOT EXISTS alert_outbox (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('breaking', 'warning', 'info')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS query_log (
  id INTEGER PRIMARY KEY,
  token_id INTEGER,
  tool TEXT NOT NULL,
  query TEXT,
  result_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS query_log_created ON query_log (created_at);
`;
