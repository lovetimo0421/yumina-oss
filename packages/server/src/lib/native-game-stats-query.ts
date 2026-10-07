import { sql } from "drizzle-orm";
import { nativeGamePlaytimeQuery } from "./native-game-playtime-query.js";

/** Canonical game totals are independent of which language card was opened.
 * Preserve recorded session history and add durable native increments after
 * reconciliation. Never use Krew token-renewal estimates. Caller authorized IDs.
 */
export function nativeGameStatsQuery(ids: readonly string[]) {
  return sql`
    WITH native_worlds AS (
      SELECT id, creator_id, is_published, language_group_id, source_world_id,
        CASE WHEN game_path IN ('/pvz', '/pvz/') THEN 'pvz'
             WHEN game_path IN ('/krew', '/krew/') THEN 'krew' END AS game_id
      FROM worlds WHERE game_path IN ('/pvz', '/pvz/', '/krew', '/krew/')
    ), requested AS (
      SELECT id, game_id FROM native_worlds
      WHERE id IN (${ids.length ? sql.join(ids.map(id => sql`${id}`), sql`, `) : sql`NULL`})
    ), creators AS (
      SELECT DISTINCT authored.game_id, authored.creator_id FROM native_worlds authored
      WHERE authored.source_world_id IS NULL AND EXISTS (
        SELECT 1 FROM native_worlds listed WHERE listed.is_published = true
          AND listed.source_world_id IS NULL AND listed.game_id = authored.game_id
          AND (listed.id = authored.id OR (authored.language_group_id IS NOT NULL
            AND listed.language_group_id = authored.language_group_id))
      )
    ), time_by_player AS (
      ${nativeGamePlaytimeQuery(sql`SELECT game_id FROM requested`)}
    ), time_totals AS (
      SELECT p.game_id, SUM(p.seconds)::double precision AS seconds
      FROM time_by_player p
      WHERE NOT EXISTS (SELECT 1 FROM creators c
          WHERE c.game_id = p.game_id AND c.creator_id = p.user_id)
      GROUP BY p.game_id
    ), dave AS (
      SELECT COUNT(*)::integer AS interactions FROM usage_logs u
      WHERE u.endpoint = 'pvz-dave' AND EXISTS (SELECT 1 FROM requested WHERE game_id = 'pvz')
        AND NOT EXISTS (SELECT 1 FROM creators c WHERE c.game_id = 'pvz' AND c.creator_id = u.user_id)
    )
    SELECT r.id, COALESCE(t.seconds, 0)::double precision AS seconds,
      CASE WHEN r.game_id = 'pvz' THEN dave.interactions ELSE 0 END AS interactions
    FROM requested r LEFT JOIN time_totals t ON t.game_id = r.game_id CROSS JOIN dave
  `;
}
