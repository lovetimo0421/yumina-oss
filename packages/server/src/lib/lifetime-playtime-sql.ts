import { sql } from "drizzle-orm";

export const LIFETIME_PLAYTIME_PENDING_DDL = `CREATE TABLE IF NOT EXISTS playtime_lifetime_pending (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  seconds integer NOT NULL CHECK (seconds > 0)
)`;

export function enqueueLifetimePlaytime(userId: string, seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("Playtime increments must be positive whole seconds");
  return sql`INSERT INTO playtime_lifetime_pending(user_id,seconds) VALUES (${userId},${seconds})
    ON CONFLICT(user_id) DO UPDATE SET seconds=playtime_lifetime_pending.seconds+EXCLUDED.seconds`;
}

export function drainLifetimePlaytime() {
  return sql`WITH pending AS MATERIALIZED (
    SELECT user_id,seconds FROM playtime_lifetime_pending ORDER BY user_id
    LIMIT 500 FOR UPDATE SKIP LOCKED
  ), credited AS (
    UPDATE "user" u SET lifetime_playtime_seconds=u.lifetime_playtime_seconds+p.seconds
    FROM pending p WHERE u.id=p.user_id RETURNING u.id
  ) DELETE FROM playtime_lifetime_pending p USING pending batch,credited c
    WHERE p.user_id=batch.user_id AND c.id=p.user_id RETURNING p.user_id`;
}
