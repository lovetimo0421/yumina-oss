import { sql } from "drizzle-orm";
import { readPublic, QUALIFIED_PLAY_SECONDS } from "../db/index.js";
import { resolveImageCdn } from "./cdn-url.js";

/**
 * Creator dashboard overview: this week vs last week, a 14-day daily series,
 * and a per-world discovery funnel with its own last-week comparison.
 *
 * Windows are rolling 24h buckets counted back from now (bucket 0 = the last
 * 24 hours), so the daily series always sums to the weekly totals shown next
 * to it. The creator's own sessions and feed events are excluded: testing your
 * own card should not move your numbers.
 *
 * Funnel stages come from one source so each rate is a true conversion:
 * impressions, clicks and plays are all discovery-feed events validated against
 * the server-issued slate (same anti-forgery rule as the ranker rollup in
 * db/index.ts). Qualified rate is over ALL plays (any source), from
 * play_sessions, matching how world_engagement_stats defines it.
 *
 * Everything runs on the replica: these are aggregates and a few seconds of
 * staleness is fine.
 */

type Rows = Array<Record<string, unknown>>;
const rowsOf = (r: unknown): Rows => (r as { rows?: Rows } | null)?.rows ?? [];
const n = (v: unknown) => Number(v ?? 0) || 0;

export interface WeekPair { cur: number; prev: number }
export interface OverviewWorld {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  language: string | null;
  variantLabel: string | null;
  impressions: WeekPair;
  clicks: WeekPair;
  feedPlays: WeekPair;
  plays: WeekPair;
  qualified: WeekPair;
  players: WeekPair;
  /** Players active the week before who came back this week (cur), and the
   *  same one week earlier (prev). `returnBase` is the week-before player count. */
  returned: WeekPair;
  returnBase: WeekPair;
  /** Playthroughs started in the last 30 days that reached each of DEPTH_TURNS player turns (branches excluded). */
  depth: number[];
}
/** How far a playthrough got, in the player's own turns. The first step is everyone who sent a first message. */
export const DEPTH_TURNS = [1, 3, 5, 10, 20, 50, 100] as const;
export interface CreatorOverview {
  totals: { plays: WeekPair; players: WeekPair; favorites: WeekPair; messages: WeekPair };
  /** Index 0 = the last 24h, 13 = 13–14 days ago. */
  daily: { plays: number[]; players: number[]; favorites: number[]; messages: number[] };
  worlds: OverviewWorld[];
  bench: { ctrPct: number | null; convPct: number | null; qualifiedPct: number | null; returnPct: number | null } | null;
}

const DAYS = 14;

/** Did this session get a player message in week `k` (0 = the last 7 days)? */
const activeIn = (sessionCol: string, k: number) => sql.raw(
  `EXISTS (SELECT 1 FROM messages m WHERE m.session_id = ${sessionCol} AND m.role = 'user'`
  + ` AND m.created_at >= now() - interval '${7 * (k + 1)} days'`
  + (k > 0 ? ` AND m.created_at < now() - interval '${7 * k} days'` : "")
  + ")",
);
const pair = (): WeekPair => ({ cur: 0, prev: 0 });
const bump = (arr: number[], i: number, v: number) => {
  if (i >= 0 && i < arr.length) arr[i] = (arr[i] ?? 0) + v;
};
const emptySeries = () => Array.from({ length: DAYS }, () => 0);

// Age bucket in whole days, 0..13.
const dayBucket = (col: string) =>
  sql.raw(`LEAST(${DAYS - 1}, GREATEST(0, floor(extract(epoch from (now() - ${col})) / 86400)))::int`);

// Per-creator result cache. A big creator's first (cold-cache) load scans
// tens of thousands of feed events and messages; nothing here needs to be
// fresher than a few minutes.
const OVERVIEW_TTL_MS = 10 * 60_000;
const OVERVIEW_CACHE_MAX = 500;
const overviewCache = new Map<string, { at: number; value: CreatorOverview }>();
const overviewInflight = new Map<string, Promise<CreatorOverview>>();

export async function getCreatorOverview(userId: string): Promise<CreatorOverview> {
  const hit = overviewCache.get(userId);
  if (hit && Date.now() - hit.at < OVERVIEW_TTL_MS) return hit.value;
  const running = overviewInflight.get(userId);
  if (running) return running;
  const p = loadCreatorOverview(userId)
    .then((value) => {
      if (overviewCache.size >= OVERVIEW_CACHE_MAX) {
        const oldest = overviewCache.keys().next().value;
        if (oldest !== undefined) overviewCache.delete(oldest);
      }
      overviewCache.delete(userId);
      overviewCache.set(userId, { at: Date.now(), value });
      return value;
    })
    .finally(() => overviewInflight.delete(userId));
  overviewInflight.set(userId, p);
  return p;
}

export async function loadCreatorOverview(userId: string): Promise<CreatorOverview> {
  const rdb = readPublic();
  const out: CreatorOverview = {
    totals: { plays: pair(), players: pair(), favorites: pair(), messages: pair() },
    daily: { plays: emptySeries(), players: emptySeries(), favorites: emptySeries(), messages: emptySeries() },
    worlds: [],
    bench: null,
  };

  const worldRows = rowsOf(await rdb.execute(sql`
    SELECT id, name, thumbnail_url, language, variant_label
    FROM worlds
    WHERE creator_id = ${userId} AND is_published = true AND status = 'published'
    ORDER BY updated_at DESC
    LIMIT 200
  `));
  if (worldRows.length === 0) {
    out.bench = await loadBench().catch(() => null);
    return out;
  }
  const ids = worldRows.map((r) => String(r.id));
  const idList = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`;
  const notMine = sql`(user_id IS NULL OR user_id <> ${userId})`;

  const byWorld = new Map<string, OverviewWorld>();
  for (const r of worldRows) {
    const id = String(r.id);
    byWorld.set(id, {
      id,
      name: String(r.name ?? ""),
      thumbnailUrl: resolveImageCdn(r.thumbnail_url ? String(r.thumbnail_url) : null),
      language: r.language ? String(r.language) : null,
      variantLabel: r.variant_label ? String(r.variant_label) : null,
      impressions: pair(), clicks: pair(), feedPlays: pair(),
      plays: pair(), qualified: pair(), players: pair(),
      returned: pair(), returnBase: pair(),
      depth: DEPTH_TURNS.map(() => 0),
    });
  }

  const sessionsPerWorld = rdb.execute(sql`
    SELECT world_id,
      (COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days'))::int AS plays_cur,
      (COUNT(*) FILTER (WHERE created_at <  now() - interval '7 days'))::int AS plays_prev,
      (COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days' AND playtime_seconds >= ${QUALIFIED_PLAY_SECONDS}))::int AS q_cur,
      (COUNT(*) FILTER (WHERE created_at <  now() - interval '7 days' AND playtime_seconds >= ${QUALIFIED_PLAY_SECONDS}))::int AS q_prev,
      (COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '7 days'))::int AS players_cur,
      (COUNT(DISTINCT user_id) FILTER (WHERE created_at <  now() - interval '7 days'))::int AS players_prev
    FROM play_sessions
    WHERE world_id = ANY(${idList}) AND created_at >= now() - interval '14 days'
      AND COALESCE(ephemeral, false) = false AND ${notMine}
    GROUP BY world_id
  `);

  const sessionsDaily = rdb.execute(sql`
    SELECT ${dayBucket("created_at")} AS d, COUNT(*)::int AS plays, COUNT(DISTINCT user_id)::int AS players
    FROM play_sessions
    WHERE world_id = ANY(${idList}) AND created_at >= now() - interval '14 days'
      AND COALESCE(ephemeral, false) = false AND ${notMine}
    GROUP BY d
  `);

  const playersWeekly = rdb.execute(sql`
    SELECT
      (COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '7 days'))::int AS cur,
      (COUNT(DISTINCT user_id) FILTER (WHERE created_at <  now() - interval '7 days'))::int AS prev
    FROM play_sessions
    WHERE world_id = ANY(${idList}) AND created_at >= now() - interval '14 days'
      AND COALESCE(ephemeral, false) = false AND ${notMine}
  `);

  const favoritesDaily = rdb.execute(sql`
    SELECT ${dayBucket("created_at")} AS d, COUNT(*)::int AS value
    FROM favorites
    WHERE world_id = ANY(${idList}) AND created_at >= now() - interval '14 days' AND ${notMine}
    GROUP BY d
  `);

  // Assistant turns (the same "messages" the per-world stats count).
  const messagesDaily = rdb.execute(sql`
    SELECT ${dayBucket("m.created_at")} AS d, COUNT(*)::int AS value
    FROM messages m
    INNER JOIN play_sessions ps ON ps.id = m.session_id
    WHERE ps.world_id = ANY(${idList})
      AND m.created_at >= now() - interval '14 days'
      AND m.role = 'assistant' AND m.status = 'complete'
      AND COALESCE(ps.ephemeral, false) = false
      AND (ps.user_id IS NULL OR ps.user_id <> ${userId})
    GROUP BY d
  `);

  const feedPerWorld = rdb.execute(sql`
    WITH valid AS (
      SELECT fe.world_id, fe.event_type, MIN(fe.created_at) AS created_at
      FROM feed_events fe
      JOIN feed_serves fs ON fs.id = fe.feed_request_id
      WHERE fe.world_id = ANY(${idList})
        AND fe.created_at >= now() - interval '14 days'
        AND fe.event_type IN ('impression', 'click', 'play')
        AND fs.world_ids ? fe.world_id
        AND (fe.user_id IS NULL OR fe.user_id <> ${userId})
      GROUP BY fe.feed_request_id, fe.world_id, fe.event_type
    )
    SELECT world_id, event_type,
      (COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days'))::int AS cur,
      (COUNT(*) FILTER (WHERE created_at <  now() - interval '7 days'))::int AS prev
    FROM valid
    GROUP BY world_id, event_type
  `);

  // Returning players. Activity = the session got a player message that week,
  // so continuing an old save counts (session start time alone misses about
  // half of returners). updated_at bounds the candidate sessions; each one is
  // then two or three index probes on messages(session_id, created_at).
  const returning = rdb.execute(sql`
    WITH s AS (
      SELECT ps.id, ps.world_id, ps.user_id
      FROM play_sessions ps
      WHERE ps.world_id = ANY(${idList}) AND ps.ephemeral = false
        AND ps.updated_at >= now() - interval '21 days' AND ps.user_id <> ${userId}
    ), a AS (
      SELECT s.world_id, s.user_id,
        ${activeIn("s.id", 0)} AS w0, ${activeIn("s.id", 1)} AS w1, ${activeIn("s.id", 2)} AS w2
      FROM s
    ), u AS (
      SELECT world_id, user_id, bool_or(w0) AS w0, bool_or(w1) AS w1, bool_or(w2) AS w2
      FROM a GROUP BY world_id, user_id
    )
    SELECT world_id,
      (COUNT(*) FILTER (WHERE w1))::int AS base_cur,
      (COUNT(*) FILTER (WHERE w1 AND w0))::int AS ret_cur,
      (COUNT(*) FILTER (WHERE w2))::int AS base_prev,
      (COUNT(*) FILTER (WHERE w2 AND w1))::int AS ret_prev
    FROM u GROUP BY world_id
  `);

  // How far playthroughs get. A branch starts with its parent's messages, so it would count the same turns twice.
  // The count stops at the last step: a thousand-turn playthrough is not read to the end (22 s became 3).
  const depth = rdb.execute(sql`
    WITH s AS (
      SELECT ps.world_id,
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM messages m WHERE m.session_id = ps.id AND m.role = 'user' LIMIT ${sql.raw(String(DEPTH_TURNS.at(-1)))}
        ) counted) AS turns
      FROM play_sessions ps
      WHERE ps.world_id = ANY(${idList}) AND ps.ephemeral = false AND ps.parent_session_id IS NULL
        AND ps.created_at >= now() - interval '30 days' AND ps.user_id <> ${userId}
    )
    SELECT world_id, ${sql.raw(DEPTH_TURNS.map((t, i) => `(COUNT(*) FILTER (WHERE turns >= ${t}))::int AS d${i}`).join(", "))}
    FROM s GROUP BY world_id
  `);

  const settled = await Promise.allSettled([
    sessionsPerWorld, sessionsDaily, playersWeekly, favoritesDaily, messagesDaily, feedPerWorld,
    loadBench(), returning, depth,
  ]);
  const ok = <T,>(i: number): T | null => {
    const s = settled[i];
    if (!s) return null;
    if (s.status === "fulfilled") return s.value as T;
    console.warn("[creator-overview] query", i, "failed:", s.reason instanceof Error ? s.reason.message : s.reason);
    return null;
  };

  for (const r of rowsOf(ok(0))) {
    const w = byWorld.get(String(r.world_id));
    if (!w) continue;
    w.plays = { cur: n(r.plays_cur), prev: n(r.plays_prev) };
    w.qualified = { cur: n(r.q_cur), prev: n(r.q_prev) };
    w.players = { cur: n(r.players_cur), prev: n(r.players_prev) };
  }
  for (const r of rowsOf(ok(8))) {
    const w = byWorld.get(String(r.world_id));
    if (w) w.depth = DEPTH_TURNS.map((_, i) => n(r[`d${i}`]));
  }
  for (const r of rowsOf(ok(1))) {
    const d = n(r.d);
    bump(out.daily.plays, d, n(r.plays));
    bump(out.daily.players, d, n(r.players));
  }
  const pw = rowsOf(ok(2))[0];
  if (pw) out.totals.players = { cur: n(pw.cur), prev: n(pw.prev) };
  for (const r of rowsOf(ok(3))) bump(out.daily.favorites, n(r.d), n(r.value));
  for (const r of rowsOf(ok(4))) bump(out.daily.messages, n(r.d), n(r.value));
  for (const r of rowsOf(ok(5))) {
    const w = byWorld.get(String(r.world_id));
    if (!w) continue;
    const p = { cur: n(r.cur), prev: n(r.prev) };
    if (r.event_type === "impression") w.impressions = p;
    else if (r.event_type === "click") w.clicks = p;
    else if (r.event_type === "play") w.feedPlays = p;
  }
  out.bench = ok<CreatorOverview["bench"]>(6);
  for (const r of rowsOf(ok(7))) {
    const w = byWorld.get(String(r.world_id));
    if (!w) continue;
    w.returnBase = { cur: n(r.base_cur), prev: n(r.base_prev) };
    w.returned = { cur: n(r.ret_cur), prev: n(r.ret_prev) };
  }

  const weekSum = (s: number[]): WeekPair => ({
    cur: s.slice(0, 7).reduce((a, b) => a + b, 0),
    prev: s.slice(7, 14).reduce((a, b) => a + b, 0),
  });
  out.totals.plays = weekSum(out.daily.plays);
  out.totals.favorites = weekSum(out.daily.favorites);
  out.totals.messages = weekSum(out.daily.messages);

  out.worlds = [...byWorld.values()];
  return out;
}

// ── Platform benchmark (7d), cached per instance ────────────────────────────
// A full feed scan is too heavy to run on every dashboard open; the number
// moves slowly, so 30 minutes of staleness is invisible.
const BENCH_TTL_MS = 30 * 60_000;
let benchCache: { at: number; value: CreatorOverview["bench"] } | null = null;
let benchInflight: Promise<CreatorOverview["bench"]> | null = null;

/** Never hold a dashboard open on the ~10s platform scan: serve the cached
 *  value (even stale) and refresh in the background; only a cold instance
 *  waits, and then at most BENCH_WAIT_MS before rendering without a bench. */
const BENCH_WAIT_MS = 2500;
async function loadBench(): Promise<CreatorOverview["bench"]> {
  if (benchCache && Date.now() - benchCache.at < BENCH_TTL_MS) return benchCache.value;
  const refresh = refreshBench().catch((err) => {
    console.warn("[creator-overview] bench refresh failed:", err instanceof Error ? err.message : err);
    return benchCache?.value ?? null;
  });
  if (benchCache) return benchCache.value;
  return Promise.race([
    refresh,
    new Promise<CreatorOverview["bench"]>((resolve) => setTimeout(() => resolve(null), BENCH_WAIT_MS)),
  ]);
}

function refreshBench(): Promise<CreatorOverview["bench"]> {
  if (benchInflight) return benchInflight;
  benchInflight = (async () => {
    const rdb = readPublic();
    const [feed, sessions, ret] = await Promise.all([
      rdb.execute(sql`
        WITH valid AS (
          SELECT fe.event_type
          FROM feed_events fe
          JOIN feed_serves fs ON fs.id = fe.feed_request_id
          WHERE fe.created_at >= now() - interval '7 days'
            AND fe.event_type IN ('impression', 'click', 'play')
            AND fs.world_ids ? fe.world_id
          GROUP BY fe.feed_request_id, fe.world_id, fe.event_type
        )
        SELECT
          (COUNT(*) FILTER (WHERE event_type = 'impression'))::bigint AS imp,
          (COUNT(*) FILTER (WHERE event_type = 'click'))::bigint AS clk,
          (COUNT(*) FILTER (WHERE event_type = 'play'))::bigint AS ply
        FROM valid
      `),
      rdb.execute(sql`
        SELECT COUNT(*)::bigint AS starts,
          (COUNT(*) FILTER (WHERE playtime_seconds >= ${QUALIFIED_PLAY_SECONDS}))::bigint AS q
        FROM play_sessions
        WHERE created_at >= now() - interval '7 days' AND COALESCE(ephemeral, false) = false
      `),
      // Per (card, player) pair, like the per-card number it is compared to.
      // Its own failure only blanks this one benchmark.
      rdb.execute(sql`
        WITH s AS (
          SELECT ps.id, ps.world_id, ps.user_id FROM play_sessions ps
          WHERE ps.ephemeral = false AND ps.updated_at >= now() - interval '14 days'
        ), u AS (
          SELECT world_id, user_id, bool_or(${activeIn("s.id", 0)}) AS w0, bool_or(${activeIn("s.id", 1)}) AS w1
          FROM s GROUP BY world_id, user_id
        )
        SELECT (COUNT(*) FILTER (WHERE w1))::bigint AS base, (COUNT(*) FILTER (WHERE w1 AND w0))::bigint AS ret FROM u
      `).catch((err) => {
        console.warn("[creator-overview] return bench failed:", err instanceof Error ? err.message : err);
        return null;
      }),
    ]);
    const f = rowsOf(feed)[0] ?? {};
    const s = rowsOf(sessions)[0] ?? {};
    const rt = rowsOf(ret)[0] ?? {};
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);
    const value = {
      ctrPct: pct(n(f.clk), n(f.imp)),
      convPct: pct(n(f.ply), n(f.clk)),
      qualifiedPct: pct(n(s.q), n(s.starts)),
      returnPct: pct(n(rt.ret), n(rt.base)),
    };
    benchCache = { at: Date.now(), value };
    return value;
  })().finally(() => { benchInflight = null; });
  return benchInflight;
}
