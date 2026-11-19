PRAGMA foreign_keys = ON;

-- The console now has one instance administrator password. The users table is retained
-- only as a compatibility owner table for existing projects and Drive connections.
CREATE TABLE IF NOT EXISTS admin_login_limits (
  key_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  locked_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_admin_login_limits_locked_until ON admin_login_limits(locked_until);

DELETE FROM admin_login_limits WHERE window_started_at < (unixepoch() - 86400);

-- Invalidate legacy Google Sign-In sessions; only password-authenticated admin sessions
-- may access the management console after this migration.
DELETE FROM sessions;
