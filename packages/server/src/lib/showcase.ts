import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export interface ShowcaseInfo {
  key: string;
  title: string;
  badge: string | null;
  tier: string | null;
}

/**
 * Batch-resolve each user's showcased achievement (key + title + badge + the
 * owner's highest earned tier) in a single query. Returns a map userId -> info
 * for the users who have a showcase set. Used to render titles next to names
 * (e.g. in the community forum). Tier ordering mirrors fetchShowcasedAchievement.
 */
export async function fetchShowcasesForUsers(
  userIds: Array<string | null | undefined>,
): Promise<Map<string, ShowcaseInfo>> {
  const out = new Map<string, ShowcaseInfo>();
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return out;
  try {
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    const res = await db.execute(sql`
      SELECT u.id AS user_id, pa.key AS key, pa.title AS title,
             COALESCE(t.badge, pa.badge) AS badge, t.level AS tier
      FROM "user" u
      JOIN platform_achievements pa ON pa.id = u.showcased_achievement_id
      LEFT JOIN LATERAL (
        SELECT pt.badge AS badge, upa.tier_level AS level
        FROM user_platform_achievements upa
        JOIN platform_achievement_tiers pt ON pt.achievement_id = upa.achievement_id AND pt.level = upa.tier_level
        WHERE upa.user_id = u.id AND upa.achievement_id = pa.id
        ORDER BY CASE upa.tier_level WHEN 'diamond' THEN 4 WHEN 'gold' THEN 3 WHEN 'silver' THEN 2 ELSE 1 END DESC
        LIMIT 1
      ) t ON true
      WHERE u.id IN (${idList}) AND u.showcased_achievement_id IS NOT NULL`);
    const rows = (Array.isArray(res) ? res : ((res as { rows?: Array<Record<string, unknown>> }).rows ?? [])) as Array<{
      user_id: string;
      key: string;
      title: string;
      badge: string | null;
      tier: string | null;
    }>;
    for (const r of rows) {
      out.set(r.user_id, { key: r.key, title: r.title, badge: r.badge, tier: r.tier });
    }
  } catch (err) {
    console.error("[showcase] fetchShowcasesForUsers failed:", (err as Error).message);
  }
  return out;
}
