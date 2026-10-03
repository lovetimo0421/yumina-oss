import { sql } from "drizzle-orm";

/** Recorded community time, across language versions. Never read message content.
 * This is foreground session time, not an estimate of a world's story length.
 */
export function worldPlaytimeQuery(ids: readonly string[]) {
  return sql`
    SELECT requested.id, COALESCE(SUM(GREATEST(ps.playtime_seconds, 0)), 0)::double precision AS seconds
    FROM worlds requested
    JOIN worlds member ON member.id = requested.id OR (
      requested.language_group_id IS NOT NULL AND member.language_group_id = requested.language_group_id
    )
    LEFT JOIN play_sessions ps ON ps.world_id = member.id
      AND ps.ephemeral = false AND ps.user_id <> member.creator_id
    WHERE requested.id IN (${ids.length ? sql.join(ids.map(id => sql`${id}`), sql`, `) : sql`NULL`})
    GROUP BY requested.id
  `;
}
