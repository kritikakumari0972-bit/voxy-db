PRAGMA foreign_keys = ON;

-- v0.3 temporarily introduced password-only console login. v0.4 restores Google
-- Sign-In; the unused rate-limit table is no longer part of the auth model.
DROP INDEX IF EXISTS idx_admin_login_limits_locked_until;
DROP TABLE IF EXISTS admin_login_limits;
