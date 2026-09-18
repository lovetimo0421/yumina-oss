// ─── Achievement engine ─────────────────────────────────────────────────────
// evaluate(userId, metricKeys) recomputes the given metrics, stores progress,
// grants any newly-crossed tiers, notifies, and re-checks the diamond capstone.
// The `on*` helpers are the fire-and-forget hooks called from write paths.

import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_KEY,
  CAPSTONE_GROUP_KEYS,
  STAR_COLLECTOR_EXCLUDE,
  maxTier,
  type AchievementDef,
  type TierLevel,
} from "./definitions.js";
import { computeMetric } from "./metrics.js";
import { notify } from "../notify.js";

// metricKey -> achievements that consume it
const ACHS_BY_METRIC = new Map<string, AchievementDef[]>();
for (const a of ACHIEVEMENTS) {
  if (!a.metricKey) continue;
  const list = ACHS_BY_METRIC.get(a.metricKey) ?? [];
  list.push(a);
  ACHS_BY_METRIC.set(a.metricKey, list);
}

/** Every metric key the engine can compute — used by full sweeps. */
export const ALL_METRIC_KEYS: string[] = [...ACHS_BY_METRIC.keys()];

// Metrics kept fresh in O(1) by their live hook (onRegenerate) and re-derived
// by the daily batch. They're the only ones that scan every message's swipes,
// so they're excluded from the catch-up-on-read sweep — opening the
// achievements page never triggers their full recompute.
export const LIVE_INCREMENTAL_METRIC_KEYS = new Set<string>(["total_regenerations", "max_regens_on_message"]);

/** Metrics the achievements page recomputes on read (everything except the
 *  live-incremental regen metrics, which the regenerate hook + daily batch own). */
export const READ_SWEEP_METRIC_KEYS: string[] = ALL_METRIC_KEYS.filter((k) => !LIVE_INCREMENTAL_METRIC_KEYS.has(k));

// ── Hot-path coalescing ──────────────────────────────────────────────
// onMessageSent / onUsageLogged / onPlaytimeTick fire on EVERY turn, and their
// metrics are aggregates over the user's whole history. Each turn used to cost
// ~8 scans of several hundred ms plus 8 progress upserts on the primary — the
// top slow-query group in prod on 2026-09-07 (55M progress-row updates for
// 670k rows). A threshold can only move by one per turn, so recomputing once
// per window per user loses nothing: a burst gets one evaluation now and one
// trailing evaluation when the window closes, so the last turn of a burst is
// never left un-graded. Per instance — a few extra runs across replicas are fine.
const HOT_EVAL_WINDOW_MS = 60_000;
const hotEvalAt = new Map<string, number>();
const hotEvalTrailing = new Map<string, ReturnType<typeof setTimeout>>();

function coalesceHot(key: string, run: () => Promise<void>): void {
  const now = Date.now();
  const last = hotEvalAt.get(key);
  if (last === undefined || now - last >= HOT_EVAL_WINDOW_MS) {
    hotEvalAt.set(key, now);
    if (hotEvalAt.size > 50_000) {
      for (const [k, t] of hotEvalAt) if (now - t >= HOT_EVAL_WINDOW_MS) hotEvalAt.delete(k);
    }
    void run().catch(() => {});
    return;
  }
  if (hotEvalTrailing.has(key)) return;
  hotEvalTrailing.set(
    key,
    setTimeout(() => {
      hotEvalTrailing.delete(key);
      hotEvalAt.set(key, Date.now());
      void run().catch(() => {});
    }, HOT_EVAL_WINDOW_MS - (now - last)),
  );
}

// Capstone wiring: each content group's diamond capstone + the regular
// achievements that must all be maxed to earn it; the global star_collector.
const GROUP_CAPSTONE = new Map<string, AchievementDef>();
const REGULAR_BY_GROUP = new Map<string, AchievementDef[]>();
for (const a of ACHIEVEMENTS) {
  if (a.isGroupCapstone) GROUP_CAPSTONE.set(a.groupKey, a);
}
for (const gk of CAPSTONE_GROUP_KEYS) {
  REGULAR_BY_GROUP.set(gk, ACHIEVEMENTS.filter((a) => a.groupKey === gk && !a.isCapstone && !a.isGroupCapstone));
}
const GLOBAL_CAPSTONE = ACHIEVEMENTS.find((a) => a.isCapstone && !a.isGroupCapstone) ?? null;

// key -> DB id cache (seed runs at startup; invalidated after each seed)
let idCache: Map<string, string> | null = null;
let idCacheAt = 0;
const ID_CACHE_TTL_MS = 30_000;
export function invalidateAchievementIdCache(): void {
  idCache = null;
}
async function achievementIds(): Promise<Map<string, string>> {
  // TTL so an out-of-process catalog reseed (which can change ids) can't leave a
  // long-running server granting against stale ids — it self-heals within 30s.
  if (idCache && Date.now() - idCacheAt < ID_CACHE_TTL_MS) return idCache;
  const res = (await db.execute(sql`SELECT id, key FROM platform_achievements`)) as unknown as
    | { rows?: Array<{ id: string; key: string }> }
    | Array<{ id: string; key: string }>;
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.key, r.id);
  idCache = m;
  idCacheAt = Date.now();
  return m;
}

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  return ((res as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

/** Insert an earned (achievement, tier) if absent. Returns true if newly granted. */
async function grantTier(userId: string, achievementId: string, achKey: string, level: TierLevel, silent = false): Promise<boolean> {
  const res = await db.execute(sql`
    INSERT INTO user_platform_achievements (id, user_id, achievement_id, tier_level, earned_at)
    VALUES (${crypto.randomUUID()}, ${userId}, ${achievementId}, ${level}, NOW())
    ON CONFLICT (user_id, achievement_id, tier_level) DO NOTHING
    RETURNING id`);
  const newly = rowsOf(res).length > 0;
  if (newly && !silent) {
    const def = ACHIEVEMENTS_BY_KEY.get(achKey);
    await notify(userId, "achievement_earned", {
      achievementKey: achKey,
      title: def?.title ?? achKey,
      tier: level,
    }, { dedupeKey: `${achKey}:${level}` }).catch(() => {});
  }
  return newly;
}

/**
 * Diamond capstones. A per-group capstone unlocks when every regular achievement
 * in its group is at max tier; the global star_collector unlocks when all five
 * group capstones are earned. Only the affected groups are re-checked.
 */
async function checkCapstones(userId: string, idMap: Map<string, string>, groupKeys: string[], silent = false): Promise<void> {
  const res = await db.execute(sql`
    SELECT pa.key AS key, upa.tier_level AS tier
    FROM user_platform_achievements upa JOIN platform_achievements pa ON upa.achievement_id = pa.id
    WHERE upa.user_id = ${userId}`);
  const earned = new Set(rowsOf(res).map((r) => `${String(r.key)}:${String(r.tier)}`));

  for (const gk of new Set(groupKeys)) {
    const cap = GROUP_CAPSTONE.get(gk);
    if (!cap || earned.has(`${cap.key}:diamond`)) continue;
    const regs = REGULAR_BY_GROUP.get(gk) ?? [];
    if (regs.length === 0) continue;
    if (!regs.every((r) => earned.has(`${r.key}:${maxTier(r).level}`))) continue;
    const capId = idMap.get(cap.key);
    if (capId && (await grantTier(userId, capId, cap.key, "diamond", silent))) earned.add(`${cap.key}:diamond`);
  }

  // Global capstone (star_collector): every non-capstone achievement except the
  // closed cohorts (founding_resident / first_dreamers) is at its max tier.
  if (GLOBAL_CAPSTONE && !earned.has(`${GLOBAL_CAPSTONE.key}:diamond`)) {
    const required = ACHIEVEMENTS.filter((a) => !a.isCapstone && !STAR_COLLECTOR_EXCLUDE.includes(a.key));
    if (required.length > 0 && required.every((a) => earned.has(`${a.key}:${maxTier(a).level}`))) {
      const gid = idMap.get(GLOBAL_CAPSTONE.key);
      if (gid) await grantTier(userId, gid, GLOBAL_CAPSTONE.key, "diamond", silent);
    }
  }
}

/** Grant any tiers a freshly-known metric value crosses. Returns whether
 *  anything new was granted; records the affected groups for the capstone pass. */
async function gradeMetric(
  userId: string,
  metricKey: string,
  value: number,
  idMap: Map<string, string>,
  silent: boolean,
  affectedGroups: Set<string>,
): Promise<boolean> {
  const achs = ACHS_BY_METRIC.get(metricKey);
  if (!achs || achs.length === 0) return false;
  let granted = false;
  for (const ach of achs) {
    const achId = idMap.get(ach.key);
    if (!achId) continue;
    for (const t of ach.tiers) {
      if (value >= t.threshold && (await grantTier(userId, achId, ach.key, t.level, silent))) {
        granted = true;
        affectedGroups.add(ach.groupKey);
      }
    }
  }
  return granted;
}

/** Recompute the given metrics for a user, store progress, grant crossed tiers. */
export async function evaluate(userId: string, metricKeys: string[], opts: { silent?: boolean } = {}): Promise<void> {
  if (!userId || metricKeys.length === 0) return;
  const silent = opts.silent ?? false;
  try {
    const idMap = await achievementIds();
    let anyGranted = false;
    const affectedGroups = new Set<string>();
    for (const metricKey of new Set(metricKeys)) {
      if (!ACHS_BY_METRIC.has(metricKey)) continue;
      const value = await computeMetric(metricKey, userId);
      await db.execute(sql`
        INSERT INTO user_achievement_progress (id, user_id, metric_key, value, updated_at)
        VALUES (${crypto.randomUUID()}, ${userId}, ${metricKey}, ${value}, NOW())
        ON CONFLICT (user_id, metric_key) DO UPDATE SET value = ${value}, updated_at = NOW()`);
      if (await gradeMetric(userId, metricKey, value, idMap, silent, affectedGroups)) anyGranted = true;
    }
    if (anyGranted) await checkCapstones(userId, idMap, [...affectedGroups], silent);
  } catch (err) {
    console.error("[achievements] evaluate failed:", (err as Error).message);
  }
}

/**
 * O(1) incremental progress bump for a live-maintained metric. Applies
 * `updateExpr` to the stored value (seeded with `seed` on first insert),
 * reads back the new value, and grants any newly-crossed tiers. Lets the hot
 * regenerate path skip the full per-message swipes rescan. For existing users
 * (who already have a progress row from a prior sweep) the increment stays
 * exact; the daily batch re-derives the true value from swipe_count, so a fresh
 * user's approximate seed self-heals within a day.
 */
async function bumpMetric(
  userId: string,
  metricKey: string,
  seed: number,
  updateExpr: SQL,
  idMap: Map<string, string>,
): Promise<void> {
  if (!ACHS_BY_METRIC.has(metricKey)) return;
  const res = await db.execute(sql`
    INSERT INTO user_achievement_progress (id, user_id, metric_key, value, updated_at)
    VALUES (${crypto.randomUUID()}, ${userId}, ${metricKey}, ${seed}, NOW())
    ON CONFLICT (user_id, metric_key) DO UPDATE SET value = ${updateExpr}, updated_at = NOW()
    RETURNING value`);
  const value = Number(rowsOf(res)[0]?.value ?? seed);
  const affectedGroups = new Set<string>();
  if (await gradeMetric(userId, metricKey, value, idMap, false, affectedGroups)) {
    await checkCapstones(userId, idMap, [...affectedGroups], false);
  }
}

/** Directly grant a specific achievement tier (admin/backfill). Fires capstone check. */
export async function grantAchievement(userId: string, achKey: string, level: TierLevel, opts: { silent?: boolean } = {}): Promise<boolean> {
  const silent = opts.silent ?? false;
  try {
    const idMap = await achievementIds();
    const achId = idMap.get(achKey);
    if (!achId) return false;
    const granted = await grantTier(userId, achId, achKey, level, silent);
    if (granted) {
      const def = ACHIEVEMENTS_BY_KEY.get(achKey);
      await checkCapstones(userId, idMap, def ? [def.groupKey] : [], silent);
    }
    return granted;
  } catch (err) {
    console.error("[achievements] grantAchievement failed:", (err as Error).message);
    return false;
  }
}

/** Delete every earned tier of one achievement for a user. Returns rows removed. */
async function removeAchievementRows(userId: string, achId: string): Promise<number> {
  const res = await db.execute(sql`
    DELETE FROM user_platform_achievements
    WHERE user_id = ${userId} AND achievement_id = ${achId}
    RETURNING id`);
  return rowsOf(res).length;
}

/**
 * Directly revoke an achievement from a user (admin toggle-off). Removes all
 * earned tiers, clears it as a profile showcase if set, and cascades: a diamond
 * capstone that required this achievement (its group capstone and/or the global
 * star_collector) is removed too, since its requirement is no longer satisfied.
 * Returns true if the user actually had the achievement.
 */
export async function revokeAchievement(userId: string, achKey: string): Promise<boolean> {
  try {
    const idMap = await achievementIds();
    const achId = idMap.get(achKey);
    if (!achId) return false;
    const removed = await removeAchievementRows(userId, achId);
    if (removed === 0) return false;

    // Drop the showcase if the user was displaying the now-revoked achievement
    // (the showcase query left-joins the earned row, so it would otherwise keep
    // rendering the title/badge with a null tier).
    await db.execute(sql`
      UPDATE "user" SET showcased_achievement_id = NULL
      WHERE id = ${userId} AND showcased_achievement_id = ${achId}`);

    // Cascade: removing a regular achievement invalidates any diamond capstone
    // that required it — the group capstone and the global star_collector.
    const def = ACHIEVEMENTS_BY_KEY.get(achKey);
    if (def && !def.isCapstone) {
      const groupCap = GROUP_CAPSTONE.get(def.groupKey);
      const isRegularOfGroup = (REGULAR_BY_GROUP.get(def.groupKey) ?? []).some((a) => a.key === achKey);
      if (groupCap && isRegularOfGroup) {
        const capId = idMap.get(groupCap.key);
        if (capId) await removeAchievementRows(userId, capId);
      }
      if (GLOBAL_CAPSTONE && !STAR_COLLECTOR_EXCLUDE.includes(achKey)) {
        const gid = idMap.get(GLOBAL_CAPSTONE.key);
        if (gid) await removeAchievementRows(userId, gid);
      }
    }
    return true;
  } catch (err) {
    console.error("[achievements] revokeAchievement failed:", (err as Error).message);
    return false;
  }
}

async function creatorOf(worldId: string): Promise<string | null> {
  try {
    const res = await db.execute(sql`SELECT creator_id AS value FROM worlds WHERE id = ${worldId} LIMIT 1`);
    return (rowsOf(res)[0]?.value as string) ?? null;
  } catch {
    return null;
  }
}

// ── Fire-and-forget hooks (call with `void`; never block the request) ──

export async function onFavoriteChanged(favoriterId: string, worldId: string): Promise<void> {
  await evaluate(favoriterId, ["favorites_count"]);
  const creatorId = await creatorOf(worldId);
  if (creatorId && creatorId !== favoriterId) {
    await evaluate(creatorId, ["creator_distinct_fans", "creator_worlds_fav50"]);
  }
}

export async function onReview(reviewerId: string, worldId: string): Promise<void> {
  await evaluate(reviewerId, ["distinct_creators_reviewed"]);
  const creatorId = await creatorOf(worldId);
  if (creatorId) await evaluate(creatorId, ["creator_quality_worlds"]);
}

export async function onPlaySession(playerId: string, worldId: string): Promise<void> {
  await evaluate(playerId, ["play_session_count", "distinct_worlds_played", "worlds_played_within_24h_of_publish"]);
  const creatorId = await creatorOf(worldId);
  if (creatorId && creatorId !== playerId) await evaluate(creatorId, ["max_world_distinct_players"]);
}

export async function onPlaytimeTick(playerId: string): Promise<void> {
  coalesceHot(`pt:${playerId}`, () => evaluate(playerId, ["max_world_playtime_seconds"]));
}

/** GREATEST(stored, messages in THIS world) — one indexed count instead of a
 *  scan of every message the player ever sent (metrics.ts max_world_message_count
 *  was the #1 disk reader in prod: 1.9B blocks over 1.7M calls). Coalesced per
 *  (user, world); the daily batch still re-derives the exact value. */
async function refreshMaxWorldMessageCount(userId: string, worldId: string): Promise<void> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS value
    FROM messages m JOIN play_sessions ps ON m.session_id = ps.id
    WHERE ps.user_id = ${userId} AND ps.world_id = ${worldId} AND ps.ephemeral = false`);
  const count = Number(rowsOf(res)[0]?.value ?? 0);
  const idMap = await achievementIds();
  await bumpMetric(userId, "max_world_message_count", count, sql`GREATEST(user_achievement_progress.value, ${count})`, idMap);
}

/**
 * A player's turn was answered. With the session + world in hand the two
 * per-message metrics are kept fresh without rescanning history:
 *   fast_followup_count  += 1 if the user turn came ≤10s after the previous
 *                            assistant turn (three indexed rows, O(1) bump —
 *                            metrics.ts's LAG() window over ALL messages was the
 *                            #2 disk reader in prod: 1.8B blocks)
 *   max_world_message_count = GREATEST(stored, this world's count) — coalesced
 * Without context (legacy callers) the full recompute runs, coalesced.
 */
export async function onMessageSent(playerId: string, ctx?: { sessionId: string; worldId: string }): Promise<void> {
  if (!ctx) {
    coalesceHot(`msg:${playerId}`, () => evaluate(playerId, ["max_world_message_count", "fast_followup_count"]));
    return;
  }
  try {
    const res = await db.execute(sql`
      SELECT role, created_at FROM messages
      WHERE session_id = ${ctx.sessionId}
      ORDER BY created_at DESC, id DESC
      LIMIT 3`);
    const recent = rowsOf(res) as Array<{ role: string; created_at: string | Date }>;
    // recent[0] is the assistant reply just persisted; the user turn before it
    // is the one being graded; the row before THAT must be an assistant turn.
    const userIdx = recent.findIndex((r) => r.role === "user");
    const userTurn = userIdx >= 0 ? recent[userIdx] : undefined;
    const prev = userIdx >= 0 ? recent[userIdx + 1] : undefined;
    if (userTurn && prev && prev.role === "assistant") {
      const gapMs = new Date(userTurn.created_at).getTime() - new Date(prev.created_at).getTime();
      if (gapMs >= 0 && gapMs <= 10_000) {
        const idMap = await achievementIds();
        await bumpMetric(playerId, "fast_followup_count", 1, sql`user_achievement_progress.value + 1`, idMap);
      }
    }
  } catch (err) {
    console.error("[achievements] onMessageSent fast-followup bump failed:", (err as Error).message);
  }
  coalesceHot(`mwmc:${playerId}:${ctx.worldId}`, () => refreshMaxWorldMessageCount(playerId, ctx.worldId));
}

export async function onReferralRegistered(referrerId: string): Promise<void> {
  await evaluate(referrerId, ["confirmed_referrals"]);
}

const USAGE_METRIC_KEYS = [
  "gemini_call_count",
  "claude_call_count",
  "grok_call_count",
  "deepseek_call_count",
  "own_model_call_count",
  "distinct_models_used",
];

/**
 * A usage_logs row was written. With the row's `model` / `apiKeyTier` the
 * model-family counters move in O(1) (same pattern as onRegenerate — the
 * family tests mirror the ILIKE predicates in metrics.ts), and only
 * `distinct_models_used`, a genuine set, is recomputed — coalesced. Without
 * usage detail (legacy callers) everything is recomputed, coalesced.
 */
export async function onUsageLogged(
  userId: string,
  usage?: { model?: string | null; apiKeyTier?: string | null },
): Promise<void> {
  if (!usage) {
    coalesceHot(`usage:${userId}`, () => evaluate(userId, USAGE_METRIC_KEYS));
    return;
  }
  const model = (usage.model ?? "").toLowerCase();
  const bumps: string[] = [];
  if (model.includes("gemini")) bumps.push("gemini_call_count");
  if (model.includes("claude") || model.includes("anthropic")) bumps.push("claude_call_count");
  if (model.includes("grok") || model.includes("x-ai")) bumps.push("grok_call_count");
  if (model.includes("deepseek")) bumps.push("deepseek_call_count");
  if (usage.apiKeyTier === "byok") bumps.push("own_model_call_count");
  if (bumps.length > 0) {
    try {
      const idMap = await achievementIds();
      for (const key of bumps) {
        await bumpMetric(userId, key, 1, sql`user_achievement_progress.value + 1`, idMap);
      }
    } catch (err) {
      console.error("[achievements] onUsageLogged bump failed:", (err as Error).message);
    }
  }
  coalesceHot(`usage:${userId}`, () => evaluate(userId, ["distinct_models_used"]));
}

/**
 * A regenerate appended exactly one swipe to one message (`newSwipeCount` = that
 * message's swipes array length after the append). Bump the two regen metrics in
 * O(1) instead of re-scanning every message's swipes jsonb:
 *   total_regenerations  += 1                              (one more regen overall)
 *   max_regens_on_message = GREATEST(prev, newSwipeCount-1) (this message's regens)
 * The daily batch (runAchievementBatch → evaluate ALL_METRIC_KEYS) re-derives both
 * from swipe_count as the self-heal, so any drift corrects within a day.
 */
export async function onRegenerate(userId: string, newSwipeCount: number): Promise<void> {
  const regenThisMsg = Math.max(Math.trunc(newSwipeCount) - 1, 0);
  if (regenThisMsg < 1) return; // the first generation is not a regeneration
  try {
    const idMap = await achievementIds();
    await bumpMetric(userId, "total_regenerations", 1, sql`user_achievement_progress.value + 1`, idMap);
    await bumpMetric(
      userId,
      "max_regens_on_message",
      regenThisMsg,
      sql`GREATEST(user_achievement_progress.value, ${regenThisMsg})`,
      idMap,
    );
  } catch (err) {
    console.error("[achievements] onRegenerate failed:", (err as Error).message);
  }
}

export async function onForumThread(authorId: string): Promise<void> {
  await evaluate(authorId, ["distinct_forum_days", "distinct_worlds_attached"]);
}

export async function onForumPost(authorId: string, threadAuthorId: string | null): Promise<void> {
  await evaluate(authorId, ["distinct_forum_days", "long_reply_threads", "top5_reply_threads", "distinct_worlds_attached"]);
  if (threadAuthorId && threadAuthorId !== authorId) {
    await evaluate(threadAuthorId, ["distinct_repliers_on_my_threads"]);
  }
}

export async function onWorldPublished(creatorId: string): Promise<void> {
  await evaluate(creatorId, ["published_world_count", "max_lang_group_size", "max_publish_delay_days"]);
}

export async function onWorldEditPublished(creatorId: string): Promise<void> {
  await evaluate(creatorId, ["max_world_public_edits", "max_edits_24h_after_publish"]);
}
