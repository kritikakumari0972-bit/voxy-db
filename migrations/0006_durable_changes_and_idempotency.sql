PRAGMA foreign_keys = ON;

-- Durable change log. `seq` is a monotonically increasing cursor per D1 database.
-- Clients use it to recover updates missed while their WebSocket was disconnected.
CREATE TABLE IF NOT EXISTS change_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('record.created', 'record.updated', 'record.deleted')),
  record_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_events_collection_seq
  ON change_events(project_id, collection_id, seq);
CREATE INDEX IF NOT EXISTS idx_change_events_created_at
  ON change_events(created_at);

-- Idempotency protects create/update/delete calls from duplicate application
-- when a client retries after a timeout or a lost response. Entries expire in 24h.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  status_code INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at);

-- Tracks the highest event sequence pruned per collection. Because the global
-- AUTOINCREMENT sequence also contains writes from other collections, the
-- retention watermark must be written explicitly rather than inferred from MIN(seq).
CREATE TABLE IF NOT EXISTS change_event_checkpoints (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  pruned_through_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, collection_id)
);
