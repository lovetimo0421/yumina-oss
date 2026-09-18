// ─── Achievement metric computations ────────────────────────────────────────
// computeMetric(metricKey, userId) returns the user's current raw value for a
// metric. Metrics with metricKey=null (admin/backfill/series achievements) are
// NOT computed here — they're granted directly by their special code paths.

import { sql, type SQL } from "drizzle-orm";
import { readPublic } from "../../db/index.js";

// Every metric is an aggregate over a user's whole history (messages, usage
// logs, sessions), recomputed from fire-and-forget hooks and the daily batch.
// A few seconds of replica lag can only delay a grant by one event — and the
// batch re-derives everything anyway — so these scans belong on the read
// replica, not in front of the auth lookups and turn writes on the primary.
// (2026-09-07: these were the #2–#5 slowest statement classes on the primary.)
async function scalar(query: SQL): Promise<number> {
  const res = (await readPublic().execute(query)) as unknown as { rows?: Array<{ value: unknown }> } | Array<{ value: unknown }>;
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  const v = rows[0]?.value;
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Compute the current value of a metric for a user. Returns 0 on any error. */
export async function computeMetric(metricKey: string, userId: string): Promise<number> {
  try {
    switch (metricKey) {
      // ── Creator ──
      case "published_world_count":
        return scalar(sql`SELECT count(*)::int AS value FROM worlds WHERE creator_id = ${userId} AND is_published = true`);
      case "creator_worlds_fav50":
        return scalar(sql`SELECT count(*)::int AS value FROM worlds WHERE creator_id = ${userId} AND favorite_count >= 50`);
      case "creator_distinct_fans":
        return scalar(sql`
          SELECT count(DISTINCT f.user_id)::int AS value
          FROM favorites f JOIN worlds w ON f.world_id = w.id
          WHERE w.creator_id = ${userId} AND f.user_id <> w.creator_id`);
      case "max_world_distinct_players":
        return scalar(sql`
          SELECT COALESCE(MAX(c), 0)::int AS value FROM (
            SELECT count(DISTINCT ps.user_id) c
            FROM play_sessions ps JOIN worlds w ON ps.world_id = w.id
            WHERE w.creator_id = ${userId} AND ps.ephemeral = false AND ps.user_id <> w.creator_id
            GROUP BY ps.world_id
          ) x`);
      case "creator_quality_worlds":
        return scalar(sql`SELECT count(*)::int AS value FROM worlds WHERE creator_id = ${userId} AND is_published = true AND average_rating >= 4.5 AND review_count >= 20`);
      case "max_lang_group_size":
        return scalar(sql`
          SELECT COALESCE(MAX(c), 0)::int AS value FROM (
            SELECT count(DISTINCT language) c FROM worlds
            WHERE creator_id = ${userId} AND is_published = true AND language_group_id IS NOT NULL
            GROUP BY language_group_id
          ) x`);
      case "max_world_public_edits":
        return scalar(sql`
          SELECT COALESCE(MAX(c), 0)::int AS value FROM (
            SELECT count(*) c FROM world_review_submissions s JOIN worlds w ON s.world_id = w.id
            WHERE w.creator_id = ${userId} AND s.submission_type = 'edit' AND s.decision = 'approved'
            GROUP BY s.world_id
          ) x`);
      case "max_edits_24h_after_publish":
        return scalar(sql`
          SELECT COALESCE(MAX(c), 0)::int AS value FROM (
            SELECT count(*) c FROM world_review_submissions s JOIN worlds w ON s.world_id = w.id
            WHERE w.creator_id = ${userId} AND s.submission_type = 'edit' AND s.decision = 'approved'
              AND s.decided_at IS NOT NULL AND w.published_at IS NOT NULL
              AND s.decided_at <= w.published_at + INTERVAL '24 hours'
            GROUP BY s.world_id
          ) x`);
      case "max_publish_delay_days":
        // FLOOR, not a bare ::int cast: ::int rounds to nearest, so a world
        // first published 6.5–7d (or 13.5–14d / 29.5–30d) after creation
        // counted as a full 7/14/30 days and earned the tier up to ~12h early.
        // 十年磨一剑 promises "first publish only N days after creating", so the
        // metric must be FULL elapsed days — FLOOR enforces that exactly.
        return scalar(sql`SELECT COALESCE(MAX(FLOOR(EXTRACT(EPOCH FROM (published_at - created_at)) / 86400)), 0)::int AS value FROM worlds WHERE creator_id = ${userId} AND published_at IS NOT NULL`);
      case "evergreen_world_count":
        return scalar(sql`
          SELECT count(*)::int AS value FROM worlds w
          WHERE w.creator_id = ${userId} AND w.published_at IS NOT NULL
            AND w.published_at <= NOW() - INTERVAL '90 days'
            AND (
              EXISTS(SELECT 1 FROM favorites f WHERE f.world_id = w.id AND f.created_at >= NOW() - INTERVAL '30 days')
              OR EXISTS(SELECT 1 FROM reviews r WHERE r.world_id = w.id AND r.created_at >= NOW() - INTERVAL '30 days')
              OR EXISTS(SELECT 1 FROM world_ratings wr WHERE wr.world_id = w.id AND wr.updated_at >= NOW() - INTERVAL '30 days')
              OR EXISTS(SELECT 1 FROM play_sessions ps WHERE ps.world_id = w.id AND ps.ephemeral = false AND ps.created_at >= NOW() - INTERVAL '30 days')
            )`);

      // ── Player ──
      case "play_session_count":
        return scalar(sql`SELECT count(*)::int AS value FROM play_sessions WHERE user_id = ${userId} AND ephemeral = false`);
      case "distinct_worlds_played":
        return scalar(sql`SELECT count(DISTINCT world_id)::int AS value FROM play_sessions WHERE user_id = ${userId} AND ephemeral = false`);
      case "max_world_playtime_seconds":
        return scalar(sql`
          SELECT COALESCE(MAX(s), 0)::int AS value FROM (
            SELECT SUM(playtime_seconds) s FROM play_sessions
            WHERE user_id = ${userId} AND ephemeral = false GROUP BY world_id
          ) x`);
      case "distinct_creators_reviewed":
        // "Reviewed" = rated. Ratings live in world_ratings (one per user per
        // card) since the 2026-08 reviews→comments split.
        return scalar(sql`
          SELECT count(DISTINCT w.creator_id)::int AS value
          FROM world_ratings r JOIN worlds w ON r.world_id = w.id
          WHERE r.user_id = ${userId} AND w.creator_id <> r.user_id`);
      case "favorites_count":
        return scalar(sql`SELECT count(*)::int AS value FROM favorites WHERE user_id = ${userId}`);
      case "worlds_played_within_24h_of_publish":
        return scalar(sql`
          SELECT count(DISTINCT ps.world_id)::int AS value
          FROM play_sessions ps JOIN worlds w ON ps.world_id = w.id
          WHERE ps.user_id = ${userId} AND ps.ephemeral = false AND w.published_at IS NOT NULL
            AND ps.created_at >= w.published_at AND ps.created_at < w.published_at + INTERVAL '24 hours'`);
      case "max_world_message_count":
        return scalar(sql`
          SELECT COALESCE(MAX(c), 0)::int AS value FROM (
            SELECT count(*) c FROM messages m JOIN play_sessions ps ON m.session_id = ps.id
            WHERE ps.user_id = ${userId} AND ps.ephemeral = false GROUP BY ps.world_id
          ) x`);

      // ── Community ──
      case "distinct_forum_days":
        return scalar(sql`
          SELECT count(*)::int AS value FROM (
            SELECT DISTINCT date_trunc('day', created_at) d FROM threads WHERE author_id = ${userId}
            UNION SELECT DISTINCT date_trunc('day', created_at) FROM posts WHERE author_id = ${userId}
          ) x`);
      case "distinct_repliers_on_my_threads":
        return scalar(sql`
          SELECT count(DISTINCT p.author_id)::int AS value
          FROM posts p JOIN threads t ON p.thread_id = t.id
          WHERE t.author_id = ${userId} AND p.author_id <> t.author_id`);
      case "long_reply_threads":
        return scalar(sql`
          SELECT count(DISTINCT p.thread_id)::int AS value
          FROM posts p JOIN threads t ON p.thread_id = t.id
          WHERE p.author_id = ${userId} AND t.author_id <> p.author_id AND char_length(p.content) >= 200`);
      case "top5_reply_threads":
        return scalar(sql`
          SELECT count(DISTINCT p.thread_id)::int AS value
          FROM posts p JOIN threads t ON p.thread_id = t.id
          WHERE p.author_id = ${userId} AND t.author_id <> p.author_id AND p.floor <= 5`);
      case "distinct_worlds_attached":
        return scalar(sql`
          SELECT count(*)::int AS value FROM (
            SELECT tw.world_id FROM thread_worlds tw JOIN threads t ON tw.thread_id = t.id WHERE t.author_id = ${userId}
            UNION SELECT pw.world_id FROM post_worlds pw JOIN posts p ON pw.post_id = p.id WHERE p.author_id = ${userId}
          ) x`);

      // ── Social ──
      // Historical metric key kept so existing progress rows stay valid. Since
      // 2026-09-16 Wayfinder counts ACTIVE friends — invitees whose referral
      // qualification settled as rewarded — not registrations (owner decision;
      // same basis as the wallet ladder). Tiers already earned are never revoked.
      case "confirmed_referrals":
        return scalar(sql`
          SELECT count(*)::int AS value FROM referral_qualifications q
          WHERE q.referrer_id = ${userId} AND q.status = 'rewarded'`);
      case "scouted_world_count":
        return scalar(sql`
          SELECT count(*)::int AS value
          FROM favorites f JOIN worlds w ON f.world_id = w.id
          WHERE f.user_id = ${userId} AND w.favorite_count >= 100 AND w.published_at IS NOT NULL
            AND f.created_at <= w.published_at + INTERVAL '30 days'`);

      // ── AI model ──
      case "gemini_call_count":
        return scalar(sql`SELECT count(*)::int AS value FROM usage_logs WHERE user_id = ${userId} AND model ILIKE '%gemini%'`);
      case "claude_call_count":
        return scalar(sql`SELECT count(*)::int AS value FROM usage_logs WHERE user_id = ${userId} AND (model ILIKE '%claude%' OR model ILIKE '%anthropic%')`);
      case "grok_call_count":
        return scalar(sql`SELECT count(*)::int AS value FROM usage_logs WHERE user_id = ${userId} AND (model ILIKE '%grok%' OR model ILIKE '%x-ai%')`);
      case "deepseek_call_count":
        return scalar(sql`SELECT count(*)::int AS value FROM usage_logs WHERE user_id = ${userId} AND model ILIKE '%deepseek%'`);
      case "own_model_call_count":
        return scalar(sql`SELECT count(*)::int AS value FROM usage_logs WHERE user_id = ${userId} AND api_key_tier = 'byok'`);
      case "distinct_models_used":
        return scalar(sql`SELECT count(DISTINCT model)::int AS value FROM usage_logs WHERE user_id = ${userId}`);
      case "fast_followup_count":
        return scalar(sql`
          SELECT count(*)::int AS value FROM (
            SELECT m.role,
              m.created_at AS at,
              LAG(m.created_at) OVER (PARTITION BY m.session_id ORDER BY m.created_at) AS prev_at,
              LAG(m.role) OVER (PARTITION BY m.session_id ORDER BY m.created_at) AS prev_role
            FROM messages m JOIN play_sessions ps ON m.session_id = ps.id
            WHERE ps.user_id = ${userId} AND ps.ephemeral = false
          ) q
          WHERE q.role = 'user' AND q.prev_role = 'assistant' AND q.prev_at IS NOT NULL
            AND q.at <= q.prev_at + INTERVAL '10 seconds'`);
      // m.swipe_count (= jsonb_array_length(swipes), maintained by a DB trigger)
      // lets these aggregate a tiny int instead of detoasting the swipes jsonb
      // per row. COALESCE to the jsonb fallback keeps the value correct for any
      // rows not yet covered by the batched backfill; once backfilled the
      // fallback never fires (no detoast). A regen = swipe_count - 1.
      case "max_regens_on_message":
        return scalar(sql`
          SELECT COALESCE(MAX(GREATEST(COALESCE(m.swipe_count, jsonb_array_length(COALESCE(m.swipes, '[]'::jsonb))) - 1, 0)), 0)::int AS value
          FROM messages m JOIN play_sessions ps ON m.session_id = ps.id
          WHERE ps.user_id = ${userId} AND m.role = 'assistant'`);
      case "total_regenerations":
        return scalar(sql`
          SELECT COALESCE(SUM(GREATEST(COALESCE(m.swipe_count, jsonb_array_length(COALESCE(m.swipes, '[]'::jsonb))) - 1, 0)), 0)::int AS value
          FROM messages m JOIN play_sessions ps ON m.session_id = ps.id
          WHERE ps.user_id = ${userId} AND m.role = 'assistant'`);

      // ── Commemorative (batch) ──
      case "current_streak_days":
        return scalar(sql`
          WITH days AS (
            SELECT DISTINCT d FROM (
              SELECT date_trunc('day', created_at)::date d FROM play_sessions WHERE user_id = ${userId} AND ephemeral = false
              UNION SELECT date_trunc('day', created_at)::date FROM threads WHERE author_id = ${userId}
              UNION SELECT date_trunc('day', created_at)::date FROM posts WHERE author_id = ${userId}
            ) z
          ), ranked AS (
            SELECT d, (d - (ROW_NUMBER() OVER (ORDER BY d))::int) AS grp FROM days
          ), runs AS (
            SELECT grp, count(*) len, MAX(d) last_day FROM ranked GROUP BY grp
          )
          SELECT COALESCE(MAX(len), 0)::int AS value FROM runs WHERE last_day >= CURRENT_DATE - 1`);

      default:
        return 0;
    }
  } catch (err) {
    console.error(`[achievements] computeMetric(${metricKey}) failed:`, (err as Error).message);
    return 0;
  }
}
