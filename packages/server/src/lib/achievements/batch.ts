// ─── Achievement batch + backfill ───────────────────────────────────────────
// Daily recompute of metrics that have no reliable per-write trigger
// (evergreen world, night-watch streak, talent-scout) + ongoing fill of the
// commemorative cohorts. Runs in-process (mirrors startDailyRecoveryInterval);
// all grants are idempotent so re-running is safe.

import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { runExclusive } from "../leader.js";
import { ALL_METRIC_KEYS, evaluate, grantAchievement } from "./engine.js";

const MAX_USERS_PER_BATCH = 5000;

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  return ((res as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

/** Grant the commemorative cohorts (idempotent). Safe to run on demand or daily.
 *  Single gold tier each: earliest 3000 active users (residents) + earliest 1000
 *  creators by first publish (dreamers). */
export async function backfillCommemoratives(opts: { silent?: boolean } = {}): Promise<{ residents: number; dreamers: number }> {
  const silent = opts.silent ?? false;
  let residents = 0;
  let dreamers = 0;
  try {
    // 梦坞原住民 — the earliest 3000 active users (≥3 user messages), ranked by signup. All gold.
    const residentRows = rowsOf(
      await db.execute(sql`
        WITH msg_users AS (
          SELECT ps.user_id AS uid, count(*) AS c
          FROM messages m JOIN play_sessions ps ON m.session_id = ps.id
          WHERE m.role = 'user'
          GROUP BY ps.user_id HAVING count(*) >= 3
        ), ranked AS (
          SELECT u.id AS id, ROW_NUMBER() OVER (ORDER BY u.created_at ASC) AS rn
          FROM "user" u JOIN msg_users mu ON mu.uid = u.id
        )
        SELECT id FROM ranked WHERE rn <= 3000`),
    );
    for (const r of residentRows) {
      if (await grantAchievement(r.id as string, "founding_resident", "gold", { silent })) residents++;
    }

    // 第一批造梦者 — the earliest 1000 creators by first publish. All gold.
    const dreamerRows = rowsOf(
      await db.execute(sql`
        WITH first_pub AS (
          SELECT creator_id AS cid, MIN(published_at) AS fp
          FROM worlds WHERE is_published = true AND published_at IS NOT NULL
          GROUP BY creator_id
        ), ranked AS (
          SELECT cid, ROW_NUMBER() OVER (ORDER BY fp ASC) AS rn FROM first_pub
        )
        SELECT cid FROM ranked WHERE rn <= 1000`),
    );
    for (const r of dreamerRows) {
      if (await grantAchievement(r.cid as string, "first_dreamers", "gold", { silent })) dreamers++;
    }
    console.log(`[achievements] backfill: residents=${residents} dreamers=${dreamers}`);
  } catch (err) {
    console.error("[achievements] backfillCommemoratives failed:", (err as Error).message);
  }
  return { residents, dreamers };
}

/**
 * Full sweep: evaluate every metric for every user so all already-satisfied
 * achievements light up at once. Fixes the "satisfied but never triggered until
 * an unrelated event fires" lag — the reactive on* hooks only evaluate a metric
 * when its own event fires, so anything met by historical data stays dark.
 * Silent by default (no notification flood). Idempotent; safe to re-run.
 * Intended as a one-time launch backfill (or admin-triggered).
 */
export async function sweepAllAchievements(opts: { silent?: boolean } = {}): Promise<{ users: number }> {
  const silent = opts.silent ?? true;
  let lastId = "";
  let users = 0;
  try {
    for (;;) {
      const batch = rowsOf(
        await db.execute(sql`SELECT id FROM "user" WHERE id > ${lastId} ORDER BY id ASC LIMIT 500`),
      ).map((r) => r.id as string);
      if (batch.length === 0) break;
      for (const uid of batch) {
        await evaluate(uid, ALL_METRIC_KEYS, { silent });
        users++;
      }
      lastId = batch[batch.length - 1]!;
    }
    await backfillCommemoratives({ silent });
    console.log(`[achievements] full sweep done: users=${users} silent=${silent}`);
  } catch (err) {
    console.error("[achievements] sweepAllAchievements failed:", (err as Error).message);
  }
  return { users };
}

/** Daily recompute of batch-only metrics for plausibly-affected users. */
export async function runAchievementBatch(): Promise<void> {
  try {
    // 守夜人 — anyone active today/yesterday (the streak must include them).
    const streakUsers = rowsOf(
      await db.execute(sql`
        SELECT DISTINCT uid FROM (
          SELECT user_id AS uid FROM play_sessions WHERE ephemeral = false AND created_at >= CURRENT_DATE - 1
          UNION SELECT author_id FROM threads WHERE created_at >= CURRENT_DATE - 1
          UNION SELECT author_id FROM posts WHERE created_at >= CURRENT_DATE - 1
        ) z LIMIT ${MAX_USERS_PER_BATCH}`),
    ).map((r) => r.uid as string);
    for (const uid of streakUsers) await evaluate(uid, ["current_streak_days"]);

    // 常青世界 — creators whose worlds are ≥90 days published.
    const evergreenCreators = rowsOf(
      await db.execute(sql`
        SELECT DISTINCT creator_id AS cid FROM worlds
        WHERE published_at IS NOT NULL AND published_at <= NOW() - INTERVAL '90 days'
        LIMIT ${MAX_USERS_PER_BATCH}`),
    ).map((r) => r.cid as string);
    for (const cid of evergreenCreators) await evaluate(cid, ["evergreen_world_count"]);

    // 伯乐 — users who favorited a world that now has ≥100 favorites.
    const scouts = rowsOf(
      await db.execute(sql`
        SELECT DISTINCT f.user_id AS uid FROM favorites f JOIN worlds w ON f.world_id = w.id
        WHERE w.favorite_count >= 100 LIMIT ${MAX_USERS_PER_BATCH}`),
    ).map((r) => r.uid as string);
    for (const uid of scouts) await evaluate(uid, ["scouted_world_count"]);

    // Self-heal: re-evaluate ALL metrics for recently-active users so anything
    // "satisfied but the live hook didn't catch" lights up within a day (also
    // covers future-added metrics). Notifies normally — these are near-real-time.
    const activeUsers = rowsOf(
      await db.execute(sql`
        SELECT DISTINCT uid FROM (
          SELECT ps.user_id AS uid FROM messages m JOIN play_sessions ps ON m.session_id = ps.id
            WHERE m.created_at >= NOW() - INTERVAL '7 days' AND ps.ephemeral = false
          UNION SELECT user_id FROM favorites WHERE created_at >= NOW() - INTERVAL '7 days'
          UNION SELECT user_id FROM reviews WHERE created_at >= NOW() - INTERVAL '7 days'
          UNION SELECT user_id FROM world_ratings WHERE updated_at >= NOW() - INTERVAL '7 days'
          UNION SELECT author_id FROM threads WHERE created_at >= NOW() - INTERVAL '7 days'
          UNION SELECT author_id FROM posts WHERE created_at >= NOW() - INTERVAL '7 days'
        ) z LIMIT ${MAX_USERS_PER_BATCH}`),
    ).map((r) => r.uid as string);
    for (const uid of activeUsers) await evaluate(uid, ALL_METRIC_KEYS);

    await backfillCommemoratives();

    console.log(`[achievements] batch done: streak=${streakUsers.length} evergreen=${evergreenCreators.length} scout=${scouts.length} active=${activeUsers.length}`);
  } catch (err) {
    console.error("[achievements] runAchievementBatch failed:", (err as Error).message);
  }
}

let interval: ReturnType<typeof setInterval> | null = null;
let kickoff: ReturnType<typeof setTimeout> | null = null;

export function startAchievementBatchInterval(): void {
  if (interval) return;
  // First run ~5 min after boot (let the server settle), then every 24h.
  // Leader-locked with a 23h TTL: the batch runs ONCE per day fleet-wide.
  // Before this, every replica ran it on every boot — a deploy-heavy day
  // meant the full-sweep (evaluate ALL metrics for a week of active users)
  // hammered the primary several times over.
  kickoff = setTimeout(() => { void runExclusive("achievements-batch", 23 * 60 * 60, runAchievementBatch); }, 5 * 60 * 1000);
  interval = setInterval(() => { void runExclusive("achievements-batch", 23 * 60 * 60, runAchievementBatch); }, 24 * 60 * 60 * 1000);
}

export function stopAchievementBatchInterval(): void {
  if (kickoff) { clearTimeout(kickoff); kickoff = null; }
  if (interval) { clearInterval(interval); interval = null; }
}
