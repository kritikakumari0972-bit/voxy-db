PRAGMA foreign_keys = ON;

ALTER TABLE projects ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'd1'
  CHECK (storage_backend IN ('d1', 'migrating', 'google_drive'));

ALTER TABLE records ADD COLUMN drive_file_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_drive_file_id ON records(drive_file_id) WHERE drive_file_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS drive_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  root_folder_id TEXT,
  connected_at TEXT NOT NULL
);
