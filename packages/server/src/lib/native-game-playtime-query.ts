import { sql, type SQL } from "drizzle-orm";

export function nativeGameIdFromPath(path: string | null | undefined): "pvz" | "krew" | null {
  if (path === "/pvz" || path === "/pvz/") return "pvz";
  if (path === "/krew" || path === "/krew/") return "krew";
  return null;
}

/** One public counter per canonical player, shared by cards and reviews.
 * Historical counters lack complete interval boundaries, so their maximum is
 * a conservative baseline, never an additive estimate. Only native increments
 * after the immutable snapshot advance it. Resolve links BEFORE taking max so
 * a later guest login cannot replay overlapping historical time.
 */
export function nativeGamePlaytimeQuery(gameIds: SQL, userIds?: readonly string[]) {
  return sql`
    WITH sources AS (
      SELECT game_id,subject,active_ms AS current_ms,0::bigint AS legacy_ms,0::bigint AS baseline_ms
      FROM native_game_playtime WHERE game_id IN (${gameIds})
      UNION ALL
      SELECT game_id,subject,0::bigint,legacy_ms,native_ms
      FROM native_game_playtime_history WHERE game_id IN (${gameIds})
    )
    SELECT s.game_id,COALESCE(link.user_id,s.subject) AS user_id,
      (GREATEST(SUM(s.legacy_ms),SUM(s.baseline_ms))
        + GREATEST(SUM(s.current_ms)-SUM(s.baseline_ms),0))::double precision / 1000 AS seconds
    FROM sources s LEFT JOIN game_guest_links link ON link.guest_id=s.subject
    WHERE ${userIds === undefined ? sql`TRUE` : sql`COALESCE(link.user_id,s.subject) IN (${userIds.length ? sql.join(userIds.map(id=>sql`${id}`),sql`, `) : sql`NULL`})`}
    GROUP BY s.game_id,COALESCE(link.user_id,s.subject)
  `;
}
