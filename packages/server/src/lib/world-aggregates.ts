import { sql } from "drizzle-orm";

/**
 * Drizzle SQL fragments that aggregate world counter columns across
 * `language_group_id` siblings. Drop these into `.select({...})` blocks
 * anywhere consumer-facing surfaces return download/message/favorite/review
 * counts or average rating.
 *
 * Rows without a language_group_id fall back to their own column value
 * (the correlated subquery returns NULL, COALESCE picks up the row value).
 *
 * Do NOT use these in:
 *   - write paths (increments stay on the specific row)
 *   - creator-total aggregates (`/api/users/me/playtime`) — would double-count
 *   - admin/analytics dashboards
 *   - Studio per-variant views
 */
export const aggregatedCounters = {
  downloadCount: sql<number>`COALESCE(
    (SELECT SUM(w_agg.download_count)::int FROM worlds w_agg
     WHERE w_agg.language_group_id IS NOT NULL
       AND w_agg.language_group_id = worlds.language_group_id),
    worlds.download_count
  )`,

  messageCount: sql<number>`COALESCE(
    (SELECT SUM(w_agg.message_count)::int FROM worlds w_agg
     WHERE w_agg.language_group_id IS NOT NULL
       AND w_agg.language_group_id = worlds.language_group_id),
    worlds.message_count
  )`,

  favoriteCount: sql<number>`COALESCE(
    (SELECT SUM(w_agg.favorite_count)::int FROM worlds w_agg
     WHERE w_agg.language_group_id IS NOT NULL
       AND w_agg.language_group_id = worlds.language_group_id),
    worlds.favorite_count
  )`,

  reviewCount: sql<number>`COALESCE(
    (SELECT SUM(w_agg.review_count)::int FROM worlds w_agg
     WHERE w_agg.language_group_id IS NOT NULL
       AND w_agg.language_group_id = worlds.language_group_id),
    worlds.review_count
  )`,

  averageRating: sql<number>`COALESCE(
    (SELECT
       CASE WHEN COUNT(*) = 0 THEN NULL
            WHEN SUM(w_agg.review_count) > 0
            THEN (SUM(w_agg.review_count * w_agg.average_rating) / SUM(w_agg.review_count))::real
            ELSE 0
       END
     FROM worlds w_agg
     WHERE w_agg.language_group_id IS NOT NULL
       AND w_agg.language_group_id = worlds.language_group_id),
    worlds.average_rating
  )`,
} as const;
