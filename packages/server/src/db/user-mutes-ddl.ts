// Shared by the local database bootstrap and the focused schema installer.
export const USER_MUTES_STATEMENTS = [`CREATE TABLE IF NOT EXISTS user_mutes (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  admin_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
)`, `CREATE INDEX IF NOT EXISTS user_mutes_expires_idx ON user_mutes(expires_at)`];
export const USER_MUTES_DDL = USER_MUTES_STATEMENTS.join(';\n') + ';';
