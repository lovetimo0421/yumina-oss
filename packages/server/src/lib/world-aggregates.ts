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
/** Temporary (owner, 2026-10-22): players see a paused download number while the real one keeps
 * counting. On: every player-facing count reads display_download_count (null = 0, so worlds published
 * after the freeze show 0). Ranking, tips and thresholds always use the live download_count. */
export const downloadDisplayFrozen = process.env.DOWNLOAD_DISPLAY_FROZEN === "true";
/** Per-row player-facing download number (creator totals and lists). */
export const displayDownloadColumn = downloadDisplayFrozen
  ? sql<number>`COALESCE(worlds.display_download_count, 0)`
  : sql<number>`worlds.download_count`;

export const aggregatedCounters = {
  downloadCount: sql<number>`COALESCE(
    (SELECT SUM(w_agg.download_count)::int FROM worlds w_agg
     WHERE w_agg.language_group_id IS NOT NULL
       AND w_agg.language_group_id = worlds.language_group_id),
    worlds.download_count
  )`,

  /** What players are shown; equals downloadCount unless the display is frozen. */
  displayDownloadCount: downloadDisplayFrozen
    ? sql<number>`COALESCE(
      (SELECT SUM(COALESCE(w_agg.display_download_count, 0))::int FROM worlds w_agg
       WHERE w_agg.language_group_id IS NOT NULL
         AND w_agg.language_group_id = worlds.language_group_id),
      COALESCE(worlds.display_download_count, 0)
    )`
    : sql<number>`COALESCE(
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
