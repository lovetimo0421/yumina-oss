import { sql } from "drizzle-orm";

/** Current recorded playtime for the same language family as the comment feed.
 * Aggregate once per author, regardless of how many comments they have posted.
 * Preview sessions are not public playtime. No message contents are read.
 */
export function reviewPlaytimeQuery(worldId: string, userIds: string[]) {
  return sql`
    SELECT ps.user_id, SUM(GREATEST(ps.playtime_seconds, 0))::double precision AS seconds
    FROM play_sessions ps
    INNER JOIN worlds w ON w.id = ps.world_id
    WHERE ps.user_id IN (${userIds.length ? sql.join(userIds.map((id) => sql`${id}`), sql`, `) : sql`NULL`})
      AND ps.ephemeral = false
      AND (w.id = ${worldId} OR (
        w.language_group_id IS NOT NULL
        AND w.language_group_id = (SELECT language_group_id FROM worlds WHERE id = ${worldId})
      ))
    GROUP BY ps.user_id
  `;
}
