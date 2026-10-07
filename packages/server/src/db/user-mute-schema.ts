// Additive and safe to re-run. Provision before accepting authenticated traffic.
export const USER_MUTE_COLUMNS_SQL = `ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS is_muted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS muted_until TIMESTAMP`;
