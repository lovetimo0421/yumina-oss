import { sql } from "drizzle-orm";

/** Each player counts once across saves and language versions, including players
 * with zero recorded time. Studio tests do not count. */
export function averageWorldPlayerPlaytime(worldId: string) {
  return sql<number>`(
    SELECT COALESCE(ROUND(SUM(GREATEST(ps.playtime_seconds, 0))::numeric
      / NULLIF(COUNT(DISTINCT ps.user_id), 0)), 0)::double precision
    FROM play_sessions ps
    WHERE ps.ephemeral = false
      AND ps.world_id IN (
        SELECT member.id FROM worlds requested
        JOIN worlds member ON member.id = requested.id OR (
          requested.language_group_id IS NOT NULL
          AND member.language_group_id = requested.language_group_id
        )
        WHERE requested.id = ${worldId}
      )
  )`;
}
