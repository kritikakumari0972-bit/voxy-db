PRAGMA foreign_keys = ON;

-- Short-lived, single-use credentials for upgrading HTTP API-key auth to a WebSocket.
CREATE TABLE IF NOT EXISTS realtime_tickets (
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_realtime_tickets_expiry ON realtime_tickets(expires_at);

-- Durable retry queue: a successful D1 write is not lost just because Drive is offline.
-- One pending job per record coalesces rapid repeated updates into the latest snapshot.
CREATE TABLE IF NOT EXISTS drive_sync_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  collection_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload_json TEXT,
  drive_file_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(record_id)
);
CREATE INDEX IF NOT EXISTS idx_drive_sync_jobs_due ON drive_sync_jobs(next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_drive_sync_jobs_project ON drive_sync_jobs(project_id, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_records_collection_updated ON records(collection_id, updated_at DESC);

DELETE FROM realtime_tickets WHERE expires_at <= unixepoch();
