import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";

/**
 * Taste lanes for the first screen of guests and brand-new accounts
 * (owner, 2026-10-14): popularity decides WHICH cards, but the screen must
 * cover what different newcomers actually come for, weighted by how often
 * each lane wins a newcomer, instead of a wall of whatever a few heavy users
 * play (2026-10-14 English guest feed: 9 of 30 male-oriented romance cards,
 * 0 female-oriented; Chinese: 7 idol sims and a "Test" card at #14).
 *
 * A lane comes from the story's AI descriptor interests where available
 * (world_recommendation_profiles), with tags as the fallback. First match wins.
 */
export const COLD_LANES = ["male_romance", "idols", "games", "romance_her", "mystery", "fandom", "fantasy", "romance", "other"] as const;
export type ColdLane = typeof COLD_LANES[number];

const tagSet = (tags: readonly string[]) => new Set(tags.map(tag => tag.trim().toLowerCase()));
const hasAny = (tags: Set<string>, values: readonly string[]) => values.some(value => tags.has(value));
const matches = (tags: Set<string>, pattern: RegExp) => [...tags].some(tag => pattern.test(tag));

export function coldLaneFor(card: { tags: readonly string[]; gamePath?: string | null }, interests: readonly string[] = []): ColdLane {
  const tags = tagSet(card.tags ?? []);
  const has = (label: string) => interests.includes(label);
  // The audience tag is the creator's own declaration; it is kept consistent
  // with worlds.target_audience by a database constraint.
  if (tags.has("男性向")) return "male_romance";
  if (has("idols") || matches(tags, /^(k-?pop|kpop|idol|idols|偶像|爱豆|愛豆|男团|女团|男團|女團)$/)) return "idols";
  if (card.gamePath || hasAny(tags, ["游戏", "遊戲", "game", "games", "pvp", "arcade", "rpg", "多人", "multiplayer", "sandbox"])) return "games";
  if (tags.has("女性向") || hasAny(tags, ["bl", "gl", "百合", "耽美", "otome", "乙女", "yuri", "yaoi"])) return "romance_her";
  if (has("mystery") || hasAny(tags, ["悬疑", "懸疑", "恐怖", "推理", "horror", "mystery", "detective", "thriller", "惊悚"])) return "mystery";
  if (has("fandom") || hasAny(tags, ["同人", "动漫", "動漫", "anime", "fanfic", "fan fiction"])) return "fandom";
  if (has("fantasy") || hasAny(tags, ["玄幻", "仙侠", "仙俠", "fantasy", "isekai", "异世界", "異世界", "魔法"])) return "fantasy";
  if (has("relationships") || hasAny(tags, ["恋爱", "戀愛", "言情", "romance"])) return "romance";
  if (has("simulation")) return "games";
  return "other";
}

export interface ColdLaneSnapshot {
  /** AI descriptor interests per world (confidence >= 0.5). */
  interests: Map<string, string[]>;
  /** Share of newcomers' first qualified plays per lane, per hub language
   * ("all" = every language). Smoothed so no lane is ever zero. */
  priors: Map<string, Record<ColdLane, number>>;
  loadedAt: number;
}

const SNAPSHOT_TTL_MS = 30 * 60_000;
const FAILURE_RETRY_MS = 60_000;
/** Pseudo-count per lane: a lane with no newcomer evidence still gets a
 * small share instead of vanishing (and a tiny language can't swing hard). */
const PRIOR_SMOOTHING = 3;
let cached: ColdLaneSnapshot | null = null;
let inflight: Promise<ColdLaneSnapshot | null> | null = null;
let failedAt = 0;

/** Owner policy (2026-10-14): newcomers' first plays partly echo what the
 * old feed showed them (27% male-oriented romance in English), and the first
 * screen should win a broad audience, so this lane's weight is capped. */
const MALE_ROMANCE_DEMAND_CAP = 0.1;

export function priorsFromCounts(counts: Partial<Record<ColdLane, number>>): Record<ColdLane, number> {
  const total = COLD_LANES.reduce((sum, lane) => sum + (counts[lane] ?? 0) + PRIOR_SMOOTHING, 0);
  const shares = Object.fromEntries(COLD_LANES.map(lane => [lane, ((counts[lane] ?? 0) + PRIOR_SMOOTHING) / total])) as Record<ColdLane, number>;
  if (shares.male_romance > MALE_ROMANCE_DEMAND_CAP) {
    const rest = 1 - shares.male_romance;
    for (const lane of COLD_LANES) if (lane !== "male_romance") shares[lane] = shares[lane] / rest * (1 - MALE_ROMANCE_DEMAND_CAP);
    shares.male_romance = MALE_ROMANCE_DEMAND_CAP;
  }
  return shares;
}

async function readSnapshot(db: Database): Promise<ColdLaneSnapshot> {
  const facets = await db.execute(sql`
    SELECT p.world_id, array_agg(DISTINCT f->>'label') AS interests
    FROM world_recommendation_profiles p,
      jsonb_array_elements(coalesce(p.descriptor->'evidence'->'facets', p.descriptor->'facets', '[]'::jsonb)) f
    WHERE f->>'kind' = 'interest' AND jsonb_typeof(f->'confidence') = 'number' AND (f->>'confidence')::float >= 0.5
    GROUP BY p.world_id`);
  const interests = new Map<string, string[]>();
  for (const row of facets.rows as Array<{ world_id: string; interests: string[] | null }>) {
    interests.set(row.world_id, row.interests ?? []);
  }
  // What wins a newcomer: each account created in the last 30 days counts
  // once, by the first story it played for at least 5 minutes in its first week.
  const firsts = await db.execute(sql`
    SELECT w.id AS world_id, w.tags, w.game_path, split_part(coalesce(w.language, ''), '-', 1) AS lang,
      (w.age_rating = 'all') AS safe, count(*)::int AS n
    FROM (
      SELECT DISTINCT ON (ps.user_id) ps.world_id
      FROM play_sessions ps JOIN "user" u ON u.id = ps.user_id
      WHERE u.created_at > now() - interval '30 days'
        AND ps.created_at < u.created_at + interval '7 days'
        AND NOT coalesce(ps.ephemeral, false) AND ps.playtime_seconds >= 300
      ORDER BY ps.user_id, ps.created_at
    ) first_play JOIN worlds w ON w.id = first_play.world_id
    WHERE w.creator_id IS NOT NULL
    GROUP BY w.id, w.tags, w.game_path, w.language, w.age_rating`);
  const counts = new Map<string, Partial<Record<ColdLane, number>>>();
  for (const row of firsts.rows as Array<{ world_id: string; tags: string[] | null; game_path: string | null; lang: string; safe: boolean; n: number }>) {
    const lane = coldLaneFor({ tags: Array.isArray(row.tags) ? row.tags : [], gamePath: row.game_path }, interests.get(row.world_id));
    // Safe readers (every guest) only see all-ages stories, so their demand is
    // measured on all-ages first plays; adult first plays count for "any".
    const levels = row.safe ? ["safe", "any"] : ["any"];
    for (const key of [row.lang || "other", "all"].flatMap(lang => levels.map(level => `${lang}:${level}`))) {
      const bucket = counts.get(key) ?? {};
      bucket[lane] = (bucket[lane] ?? 0) + Number(row.n);
      counts.set(key, bucket);
    }
  }
  const priors = new Map<string, Record<ColdLane, number>>();
  for (const [key, bucket] of counts) priors.set(key, priorsFromCounts(bucket));
  return { interests, priors, loadedAt: Date.now() };
}

/** Cached for 30 minutes; never blocks or fails a feed (null → tag lanes, even priors). */
export async function loadColdLaneSnapshot(db: Database): Promise<ColdLaneSnapshot | null> {
  const now = Date.now();
  if (cached && now - cached.loadedAt < SNAPSHOT_TTL_MS) return cached;
  if (inflight) return inflight;
  if (!cached && now - failedAt < FAILURE_RETRY_MS) return null;
  inflight = readSnapshot(db)
    .then(snapshot => (cached = snapshot))
    .catch(error => {
      failedAt = Date.now();
      console.warn("[cold-lanes] snapshot unavailable; tag lanes with even priors", error instanceof Error ? error.message : error);
      return cached;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function priorsFor(snapshot: ColdLaneSnapshot | null | undefined, language: string | null | undefined,
  contentLevel: string = "safe"): Record<ColdLane, number> {
  const level = contentLevel === "safe" ? "safe" : "any";
  return snapshot?.priors.get(`${language ?? "all"}:${level}`) ?? snapshot?.priors.get(`all:${level}`) ?? priorsFromCounts({});
}
