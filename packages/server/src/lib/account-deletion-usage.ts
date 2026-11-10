import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

export type PreserveTotalsExecutor = {
  execute(query: SQL): Promise<unknown>;
};

/** Per-user usage/play facts that feed platform totals (admin + warehouse). */
export const DELETED_USAGE_TABLES = [
  "usage_logs",
  "analytics_play_intervals",
  "analytics_activity",
  "daily_user_activity",
] as const;

export const DELETED_USAGE_ACTOR_PREFIX = "deleted:";

/**
 * Keep a deleted account's contribution to platform totals.
 *
 * - Usage/play rows are re-keyed to a fresh `deleted:<uuid>` actor rather than
 *   deleted. The actor is random per deletion and stored nowhere else, so the
 *   rows can't be tied back to the person or a later same-email account, yet
 *   every distinct-people count still sees one person.
 * - The lifetime playtime counter lives on the user row itself, so it is
 *   carried into the identity-free `account_deletions` ledger, which is also
 *   the admin "deleted accounts" count.
 *
 * A table that still has a user FK (DB not yet migrated) is skipped and left to
 * its old cascade: re-keying it would violate the FK and abort the deletion.
 * Must run inside the deletion transaction, before the user row is deleted.
 */
export async function preserveDeletedAccountTotals(
  executor: PreserveTotalsExecutor,
  userId: string,
  actorId = `${DELETED_USAGE_ACTOR_PREFIX}${randomUUID()}`,
): Promise<{ actorId: string; tables: string[] }> {
  const candidates = sql.join(DELETED_USAGE_TABLES.map((name) => sql`${name}`), sql`,`);
  const result = await executor.execute(sql`
    SELECT t.name
    FROM unnest(ARRAY[${candidates}]::text[]) AS t(name)
    WHERE to_regclass('public.' || t.name) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid = to_regclass('public.' || t.name)
          AND c.confrelid = to_regclass('public."user"')
      )
  `);
  const tables = ((result as { rows?: Array<{ name: string }> }).rows ?? []).map((row) => row.name);
  for (const table of tables) {
    await executor.execute(sql`UPDATE ${sql.identifier(table)} SET user_id = ${actorId} WHERE user_id = ${userId}`);
  }
  await executor.execute(sql`
    INSERT INTO account_deletions (id, deleted_at, account_created_at, lifetime_playtime_seconds, source)
    SELECT ${randomUUID()}, NOW(), created_at, GREATEST(COALESCE(lifetime_playtime_seconds, 0), 0), 'deletion'
    FROM "user" WHERE id = ${userId}
  `);
  return { actorId, tables };
}
