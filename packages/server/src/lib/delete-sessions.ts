import { sql, type SQL } from "drizzle-orm";

/** Run inside a transaction. Keep the world's ID on historical usage before
 * the session FK becomes null; no conversation content is retained here. */
export async function deleteSessionsKeepingUsage(
  execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>,
  userId: string,
  scope: { sessionId: string } | { worldIds: string[] },
) {
  if ("worldIds" in scope && !scope.worldIds.length) return [];
  const predicate = "sessionId" in scope
    ? sql`s.id=${scope.sessionId}`
    : sql`s.world_id IN (${sql.join(scope.worldIds.map(id => sql`${id}`), sql`,`)})`;
  const owned = await execute(sql`SELECT s.id FROM play_sessions s
    WHERE s.user_id=${userId} AND ${predicate} ORDER BY s.id FOR UPDATE`);
  if (!owned.rows.length) return [];
  const ids = sql.join(owned.rows.map(r => sql`${String(r.id)}`), sql`,`);
  await execute(sql`UPDATE usage_logs u SET analytics_world_id=s.world_id
    FROM play_sessions s WHERE u.session_id=s.id AND s.id IN (${ids})
      AND s.user_id=${userId} AND u.user_id=${userId}
      AND (u.analytics_world_id IS NULL OR u.analytics_world_id='')`);
  return (await execute(sql`DELETE FROM play_sessions WHERE user_id=${userId}
    AND id IN (${ids}) RETURNING id`)).rows;
}
