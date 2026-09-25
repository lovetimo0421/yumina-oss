/**
 * Engagement-aware ranking (recsys Ship 1).
 *
 * The measured problem (2026-08-18 investigation, docs/recsys/): the
 * recommended feed sprayed impressions almost uniformly while demand was
 * hyper-concentrated — worlds at equal ~10k impressions ranged 0.84% to
 * 32.7% CTR, and the personalized feed's CTR (4.09%) LOST to plain
 * newest (7.96%). Nothing in the scorer ever looked at how users actually
 * responded to what it showed.
 *
 * This module closes the loop with four empirical terms fed by
 * `world_engagement_stats` (refreshed every 5 min from feed_events +
 * play_sessions, snapshotted in Redis):
 *
 *   ctr       — Bayesian-smoothed feed CTR vs the global average.
 *               The misallocation killer: proven clickers rise, proven
 *               ignorables sink.
 *   quality   — qualified-play rate (sessions reaching ≥300s) among
 *               starts. The anti-clickbait counterweight: a pretty cover
 *               that bounces everyone earns CTR but loses here.
 *   velocity  — plays this 7d vs previous 7d. "Trending" was previously
 *               inexpressible (all counters were lifetime-cumulative).
 *   explore   — optimistic rotation bonus for under-exposed young worlds
 *               (the Douyin/XHS "traffic pool" idea, deterministic daily
 *               or visit-seeded rotation). New creators get a
 *               real audition instead of permanent obscurity.
 *
 * Plus two per-user negatives:
 *
 *   fatigue    — a world shown to THIS user many times without a click
 *                stops being reshown ahead of fresh options.
 *   dismissals — explicit "not interested" hard-excludes (applied in the
 *                handler for BOTH experiment arms; it's product behavior,
 *                not a ranking experiment).
 *
 * Arms (2026-09-24): every guest and account rides engage_v1. The model
 * arm (engage_v2) opens 50/50 for accounts only once a time-spent model
 * (the discovery-features-v3 contract) is published; the retired
 * story-stats model never opens it. control is retired: it lost to both
 * treatment arms on every metric for five weeks. Recommended HTTP
 * responses are private, no-store; feed caching stays server-side in
 * Redis. `hub_serve.variant` + `feed_serves.variant` carry the arm for
 * measurement.
 *
 * Everything degrades to zero contribution when the stats table / Redis /
 * rows are missing, so deploys ahead of DDL (or an empty dev DB) behave
 * exactly like control.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { EngagementSnapshotCache } from "./engagement-snapshot-cache.js";
import { redis } from "./redis.js";
import type { RankerModelHandle } from "./ranker-model.js";

// ─── Experiment arm ──────────────────────────────────────────────────

/**
 * control   — the pre-Ship-1 hand-tuned formula. Retired 2026-09-24 (kept
 *             in the type for stored serves and old reports; never assigned).
 * engage_v1 — heuristic engagement terms (CTR/quality/velocity/explore/fatigue).
 *             Since 2026-09-24 the arm everyone rides.
 * engage_v2 — the model arm: the published model replaces the
 *             ctr/quality/velocity heuristics (it consumed those as
 *             features); explore/fatigue/session stay additive. Opens only
 *             for a time-spent (v3) model, see modelArmEligible.
 */
export type FeedVariant = "control" | "engage_v1" | "engage_v2";

/** FNV-1a 32-bit → [0, 1). Deterministic; same function family the cold
 * slate uses for its daily jitter. */
export function fnvHash01(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

/** A ranker input only the time-spent (discovery-features-v3) contract
 * produces. Its presence tells the arm assignment that a published model
 * learned from user×card history, seen cards and the multi-day label,
 * rather than being the retired story-stats model. */
export const TIME_SPENT_MODEL_MARKER = "exp_seen_before";

/** Does a published model open the model arm? Only a time-spent model does.
 * The legacy 29-input model serves nobody: it trailed engage_v1 on every
 * metric for a month, and the v3 exam compares against engage_v1's served
 * order, so engage_v1 stays the single incumbent until v3 passes. */
export function modelArmEligible(model: Pick<RankerModelHandle, "featureNames"> | null | undefined): boolean {
  return Boolean(model && model.featureNames.includes(TIME_SPENT_MODEL_MARKER));
}

/**
 * Deterministic per-user experiment arm.
 *
 * 2026-09-24: control and the legacy model arm are retired. Everyone rides
 * engage_v1 until a time-spent model publishes; then accounts split 50/50
 * between engage_v1 and engage_v2 by the same FNV bucket as before, so the
 * accounts that were in engage_v1 under the old 40/40/20 split (buckets
 * [0,40)) stay there. Guests always ride engage_v1: their feed is one
 * shared, deterministic document per language, so a guest experiment would
 * need its own assignment and cache keys.
 */
export function feedVariantFor(userId?: string | null, modelArmOpen = false): FeedVariant {
  if (!userId || !modelArmOpen) return "engage_v1";
  return fnvHash01(`feedexp1:${userId}`) * 100 < 50 ? "engage_v1" : "engage_v2";
}

/** Does this arm receive the engagement context at ranking time? BOTH
 * treatment arms do — engage_v2 is where the learned-model lift lives, and
 * engage_v1 the heuristic terms. Only control is excluded (it must score
 * byte-identically to the pre-Ship-1 formula). The hub handler gates the
 * `engagement:` rank option on this; keeping the predicate here (with a
 * test) stops the Ship-1 `=== "engage_v1"` regression from recurring the
 * next time an arm is added. */
export function variantUsesEngagement(variant: FeedVariant): boolean {
  return variant !== "control";
}

// ─── Types ───────────────────────────────────────────────────────────

export interface WorldEngagementStat {
  worldId: string;
  /** Source rollup timestamp, not cache-load/ranking time. Absent on older cached snapshots. */
  updatedAt?: string;
  impressions7d: number;
  clicks7d: number;
  playsStarted7d: number;
  qualifiedPlays7d: number;
  playsPrev7d: number;
  impressionsTotal: number;
  clicksTotal: number;
  /** Retention-proven cold-start signals (30d): distinct returners (≥2
   * sessions) and total capped playtime minutes. Consumed by the cold-start
   * slate composer, not the per-user scorer. */
  returners30d: number;
  totalPlayMinutes30d: number;
}

export interface EngagementGlobals {
  /** Global feed CTR (clicks7d/impressions7d across the catalog). */
  ctr: number;
  /** Global qualified-play rate (qualified7d/starts7d across the catalog). */
  qualifiedRate: number;
}

/**
 * A user's revealed production-value taste, inferred from the worlds they
 * ACTUALLY played (depth-weighted, meaningful plays only). Nobody ticks a
 * "I like heavy UI" box — the inference is: played mostly 1000+-LOC
 * custom-UI, audio-rich, high-token worlds → uiTier≈3, audio≈1, high
 * logTokens → candidates matching that craft level get boosted, and
 * bare-bones cards get demoted for THIS user (and vice versa for users
 * who demonstrably prefer simple cards — it's a match, not a quality
 * ladder). Computed in the recommendation profile builder.
 */
export interface CraftAffinity {
  /** Depth-weighted mean custom-UI tier of played worlds (0-3). */
  uiTier: number;
  /** Depth-weighted share of played worlds with audio (0-1). */
  audio: number;
  /** Depth-weighted mean log1p(totalTokens) of played worlds. */
  logTokens: number;
  /** Distinct meaningful plays behind the estimate. */
  sampleSize: number;
}

/** One user's history with one card, from feed_events over 30 days. */
export interface ExposureStat {
  impressions7d: number;
  impressions14d: number;
  impressions30d: number;
  clicks14d: number;
  clicks30d: number;
  /** Epoch ms of the latest impression / click, or null. */
  lastImpressionAt: number | null;
  lastClickAt: number | null;
}

export interface EngagementContext {
  variant: FeedVariant;
  /** Context-local map; loaded snapshot rows are shared and frozen. Replace a
   * map entry to override it instead of mutating its row. */
  stats: Map<string, WorldEngagementStat>;
  globals: EngagementGlobals;
  /** worldId → unclicked impressions shown to THIS user in the last 14d.
   * Only worlds at/above the light-fatigue threshold are present. Derived
   * from `exposure`; kept so the v1 heuristic penalty is unchanged. */
  fatigue: Map<string, number>;
  /** worldId → this user's history with the card over the last 30 days
   * (our own feed log). The learned ranker reads it as features, so the
   * data decides how much a passed card should drop and for how long
   * (owner, 2026-09-24: scrolling past is weak evidence, not a "no"). */
  exposure: Map<string, ExposureStat>;
  /** Long-term content-taste centroid from the profile (unit vector), or
   * null for cold users. Set by the handler once the profile loads. */
  tasteCentroid: number[] | null;
  /** profile.effectiveSignalCount, set by the handler with the tier. */
  profileSignalCount: number;
  /** Worlds this user explicitly marked "not interested". */
  dismissedWorldIds: Set<string>;
  /** Session-level adaptation (Ship 2, the no-quiz cold-start): unit
   * centroid of the embeddings of worlds this user clicked/played in the
   * last ~45 minutes, plus their tag union. Candidates similar to what
   * the user is tapping RIGHT NOW get boosted on the next page. */
  sessionCentroid: number[] | null;
  sessionTags: Set<string>;
  /** Profile tier — set by the handler after the profile loads (both load
   * in parallel). Feeds the ranker model's tier features. */
  tier: "cold" | "warm" | "mature" | null;
  /** Revealed production-value taste — set by the handler from the
   * profile (see CraftAffinity). Null until ≥3 meaningful plays. */
  craft: CraftAffinity | null;
  /** Published LightGBM model (engage_v2 only; null = fall back to v1). */
  model: RankerModelHandle | null;
  /** The viewing user's ALS latent taste vector (unit-normalized), or null
   * (guest / too few plays to be in the factorization). */
  userLatent: number[] | null;
  /** worldId → unit-normalized ALS latent vector, for every published world
   * ALS could place. Missing = new/low-play world (content term covers it). */
  // Loaded vectors are shared and frozen; this map belongs to the context.
  worldLatent: Map<string, number[]>;
  /** Treatment-arm rotation seed. Cursor feeds use `${actor}:${visitId}`
   * for signed-in and guest visits; legacy offset feeds use
   * `${userId}:${45-min bucket}` for signed-in users. Order stays stable
   * within a visit and rotates between visits. Null for legacy offset
   * guests, preserving their deterministic server-cached baseline, and
   * for control (byte-identical pre-Ship-1 scoring). */
  rotationSeed: string | null;
}

export interface EngagementBreakdown {
  ctr: number;
  quality: number;
  velocity: number;
  fatiguePenalty: number; // stored as a positive magnitude, subtracted in total
  explore: number;
  /** Session-adaptation boost (v1 + v2): similar to what you tapped just now. */
  session: number;
  /** Production-value taste match (±, see CraftAffinity). */
  craft: number;
  /** Behavioral co-play affinity: an ALS neighbor of the user's recent
   * worlds ("players like you play this"). Owner decision 2026-08-19: this
   * signal lives INSIDE the grid ranking, not as a labeled shelf. */
  coPlay: number;
  /** Learned-model lift (engage_v2 with a published model; else 0). */
  model: number;
  /** Behavioral latent affinity (ALS matrix factorization): cosine between
   * the user's and the world's learned latent vectors. Discovers cross-genre
   * connections no tag encodes ("sci-fi fan also plays adventure"). 0 when
   * either vector is missing (cold user / new world — the content vectorScore
   * term covers those instead). */
  latent: number;
  total: number;
}

export const EMPTY_ENGAGEMENT_BREAKDOWN: EngagementBreakdown = {
  ctr: 0,
  quality: 0,
  velocity: 0,
  fatiguePenalty: 0,
  explore: 0,
  session: 0,
  craft: 0,
  coPlay: 0,
  model: 0,
  latent: 0,
  total: 0,
};

// ─── Scoring constants ───────────────────────────────────────────────
// Calibrated against the existing baseScore scale (tag match ≤~208,
// quality ~90 cap, vector ≤60, presentation ≤50, freshness ≤18): the CTR
// term is deliberately the second-strongest force after tag personalization
// because measured CTR spread (0.84%–32.7% at equal exposure) is the
// single largest signal the old formula ignored.

/** Weight and cap for the smoothed-CTR lift term. ln keeps it symmetric:
 * a 2× CTR world gets +48.5, a ½× world −48.5; caps land at [−52.5, +87.5]. */
const CTR_WEIGHT = 70;
const CTR_PRIOR_IMPRESSIONS = 200; // pseudo-impressions pulled toward global CTR
const CTR_MIN_IMPRESSIONS = 50;    // below this the term is 0 (explore owns low-data)
const CTR_LN_MIN = -0.75;
const CTR_LN_MAX = 1.25;

/** Qualified-play-rate lift (qualified/starts vs global). Anti-clickbait. */
const QUALITY_WEIGHT = 45;
const QUALITY_PRIOR_PLAYS = 20;
const QUALITY_MIN_PLAYS = 5;
const QUALITY_LN_MIN = -0.75;
const QUALITY_LN_MAX = 1.0;

/** Play-velocity term: ln((plays7+3)/(playsPrev7+3)), so a world going
 * 0→20 plays gets ln(23/3)≈2.0 → capped; a world halving decays gently. */
const VELOCITY_WEIGHT = 25;
const VELOCITY_MIN_TOTAL_PLAYS = 6;
const VELOCITY_LN_MIN = -0.7;
const VELOCITY_LN_MAX = 1.4;

/** Per-user fatigue: N viewport-confirmed impressions in 14d with zero
 * clicks/plays → stepped demotion. Mirrors X's feedback-fatigue window. */
export const FATIGUE_LIGHT_IMPRESSIONS = 8;
export const FATIGUE_HEAVY_IMPRESSIONS = 16;
/** Points a card loses once repeated unclicked showings have used up its
 * click rate entirely; the measured share still kept scales it down. 90 sits
 * between the two anchors the old cliff implied (35 at 8 showings, 55 at 16). */
const FATIGUE_WEIGHT = 90;

/** Share of the first showing's click rate a card keeps on its n-th showing
 * to the same user. Viewport impressions, 14 days, measured 2026-09-24
 * (docs/recsys/2026-09-24-time-spent-recsys-design.md §1): 4.93% → 4.17%
 * → 3.92% → 3.65% (4th–7th) → 2.93% (8th–15th) → 2.25% (16th+). */
export function fatigueKeep(showing: number): number {
  if (showing <= 1) return 1;
  if (showing === 2) return 0.85;
  if (showing === 3) return 0.80;
  if (showing <= 7) return 0.74;
  if (showing <= 15) return 0.59;
  return 0.46;
}

/** Discount for the NEXT showing given this user's unclicked history with
 * the card. A smooth curve, not a cliff: a passed card sinks gradually
 * instead of vanishing at exactly eight showings, and a card that still
 * converts is never hidden. A clicked card is never fatigued. */
export function fatigueDiscount(stat: ExposureStat | undefined): number {
  if (!stat || stat.clicks14d > 0 || stat.impressions14d < 1) return 0;
  return Math.round(FATIGUE_WEIGHT * (1 - fatigueKeep(stat.impressions14d + 1)) * 10) / 10;
}

/** Exploration eligibility: young + under-exposed. Consumed by the
 * deep-slot injector in recommendations.ts (not an additive score — see
 * the note inside scoreEngagement). */
const EXPLORE_MAX_IMPRESSIONS = 500;
const EXPLORE_MAX_AGE_DAYS = 60;

/** Is this world still in its audition window (young + under-exposed)? */
export function isExploreEligible(
  candidate: EngagementCandidate,
  stat: WorldEngagementStat | undefined,
  now: Date,
): boolean {
  if ((stat?.impressionsTotal ?? 0) >= EXPLORE_MAX_IMPRESSIONS) return false;
  return candidateAgeDays(candidate, now) <= EXPLORE_MAX_AGE_DAYS;
}

/** Prior strength for a newcomer's audition estimate: pseudo-impressions
 * pulled toward the pool's own rate. */
const EXPLORE_PRIOR_IMPRESSIONS = 100;

/** Pool rate for auditions: qualified plays per feed impression over 7 days
 * across the candidates that have impressions. Falls back to the product of
 * the global click rate and qualified rate when nothing in the pool has
 * been shown yet. Never zero, so the posterior keeps a spread. */
export function exploreValuePrior(stats: Iterable<WorldEngagementStat | undefined>, globals: EngagementGlobals): number {
  let qualified = 0, impressions = 0;
  for (const stat of stats) if (stat && stat.impressions7d > 0) { qualified += stat.qualifiedPlays7d; impressions += stat.impressions7d; }
  const fallback = Math.max(globals.ctr * globals.qualifiedRate, 1e-4);
  return impressions > 0 ? Math.min(1, Math.max(qualified / impressions, 1e-4)) : fallback;
}

/** Thompson-style audition draw for a newcomer (2026-09-24): one sample per
 * (visit, card) from the posterior of its qualified plays per impression —
 * Beta posterior, normal approximation, prior = pool rate over
 * EXPLORE_PRIOR_IMPRESSIONS pseudo-impressions. An untested story draws
 * widely and earns its audition; a story that keeps failing draws low and
 * yields its slot; a story that holds attention draws high and expands.
 * Deterministic per seed, so pages within one visit agree with each other.
 * This is the data-driven form of Roblox's "test and expand", using the
 * five-minute rollups the ranker already holds. */
export function exploreValueSample(stat: WorldEngagementStat | undefined, prior: number, seed: string): number {
  const impressions = Math.max(0, stat?.impressions7d ?? 0);
  const qualified = Math.min(Math.max(0, stat?.qualifiedPlays7d ?? 0), impressions);
  const n = impressions + EXPLORE_PRIOR_IMPRESSIONS;
  const mean = Math.min(1, Math.max(0, (qualified + EXPLORE_PRIOR_IMPRESSIONS * prior) / n));
  const sd = Math.sqrt(Math.max(mean * (1 - mean), 1e-8) / n);
  const u1 = Math.min(Math.max(fnvHash01(`${seed}:u1`), 1e-9), 1 - 1e-9);
  const u2 = fnvHash01(`${seed}:u2`);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, mean + sd * z);
}

/** Deterministic rotation score in [0,1) — same hash family as the cold
 * slate, so caches stay coherent while newcomers take turns. With a
 * rotationSeed (treatment arms) newcomers rotate per VISIT — each return
 * to Discover auditions a different set of young worlds. Without a seed,
 * the rotation stays daily. */
export function exploreRotationScore(worldId: string, now: Date, rotationSeed?: string): number {
  if (rotationSeed) return fnvHash01(`${rotationSeed}:exp:${worldId}`);
  const dayKey = Math.floor(now.getTime() / 86_400_000);
  return fnvHash01(`${dayKey}:exp:${worldId}`);
}

/** Per-visit freshness jitter (treatment arms): a seeded ±ROTATION_JITTER
 * nudge on the final score so each visit reorders cards WITHIN quality
 * neighborhoods — the feed feels alive on return without letting a weak
 * card jump the ranking. Sized well under the CTR (±87) and session (≤80)
 * terms; combined with impression fatigue (−35/−55 on repeatedly ignored
 * cards) this is the TikTok "refresh = new things" loop adapted to a
 * 1k-world catalog. */
const ROTATION_JITTER = 10;

/** Learned-model lift (engage_v2): same ln-ratio shape as the CTR term.
 * Regression model (current) → ratio of predicted MINUTES to the model's
 * eval-set baseline (a world expected to generate 5min when the typical
 * world generates ~0.5min gets a big lift). Legacy binary model → ratio of
 * predicted P(click) to the global click prior. Either way it replaces the
 * ctr/quality/velocity heuristics (they're the model's own features, so
 * keeping them too would double-count). */
const MODEL_WEIGHT = 90;
const MODEL_LN_MIN = -1.0;
const MODEL_LN_MAX = 1.6;
/** Smoothing added to both sides of the predicted-minutes ratio so a world
 * predicted at ~0 minutes doesn't produce ln(0), and tiny absolute
 * differences near zero don't swing the lift. Matches the ~0.5min baseline
 * scale. */
const MODEL_VALUE_PRIOR_MIN = 0.5;

/** Session-adaptation weights: embedding similarity to what the user
 * tapped in the last ~45 min (squared, floor/cap mapped like the profile
 * vector term) + shared-tag bonus. Deliberately strong — this is the
 * cold-start answer without a signup quiz: the second page already knows
 * what the first page taught us. */
const SESSION_VECTOR_WEIGHT = 50;
const SESSION_TAG_WEIGHT = 15;
const SESSION_TAG_CAP = 2;
const SESSION_COSINE_FLOOR = 0.3;
const SESSION_COSINE_CAP = 0.85;
const SESSION_WINDOW_MINUTES = 45;
const SESSION_MAX_WORLDS = 8;

/** Flat boost for candidates surfaced by the co_played recall route — an
 * ALS neighbor of the user's 5 most recent worlds. Sized between the tag
 * and lineage components: behavioral neighborship is stronger evidence
 * than one shared tag, weaker than an explicit follow. */
const CO_PLAY_BONUS = 18;

/** Behavioral latent affinity (ALS matrix factorization): cosine between the
 * user's and the world's learned latent vectors, mapped like the content
 * vector term (floor/cap → [0,1], squared). This is the collaborative-
 * filtering signal that finds cross-genre connections behavior reveals but
 * tags don't. ALS cosines run lower/tighter than content-embedding cosines,
 * so the floor/cap band is narrower. Sized alongside the content vector
 * term — the two are complementary (behavior vs semantics). */
const LATENT_WEIGHT = 55;
const LATENT_COSINE_FLOOR = 0.15;
const LATENT_COSINE_CAP = 0.6;

/** Craft-match weights: each term is centered (perfect match = +W/2,
 * maximal mismatch = −W/2), so heavy-UI lovers pull heavy cards UP while
 * minimalists pull them DOWN — a taste match, not a quality ladder. */
const CRAFT_UI_WEIGHT = 24;
const CRAFT_AUDIO_WEIGHT = 12;
const CRAFT_TOKEN_WEIGHT = 16;
const CRAFT_MIN_SAMPLE = 3;
/** log1p(tokens) gap treated as "completely different scale". */
const CRAFT_TOKEN_GAP_SCALE = 2.5;

function customUiTier(loc: number | null | undefined): number {
  const value = loc ?? 0;
  if (value >= 1000) return 3;
  if (value >= 500) return 2;
  if (value >= 200) return 1;
  return 0;
}

function clampLn(ratio: number, min: number, max: number): number {
  if (!(ratio > 0)) return min;
  return Math.min(max, Math.max(min, Math.log(ratio)));
}

// Local vector helpers (recommendations.ts has private equivalents; this
// module must not import it — recommendations imports engagement).
function l2Normalize(vec: number[]): number[] | null {
  let mag = 0;
  for (const v of vec) mag += v * v;
  mag = Math.sqrt(mag);
  if (!(mag > 0)) return null;
  return vec.map((v) => v / mag);
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Parse a pgvector string ("[0.1,...]") or pass through an array. */
function parseVec(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const parts = trimmed.slice(1, -1).split(",");
  const out = new Array<number>(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (Number.isNaN(n)) return null;
    out[i] = n;
  }
  return out;
}

// ─── Pure scoring ────────────────────────────────────────────────────

/** Everything the engagement scorer + ranker features can read off a
 * candidate. Structurally satisfied by RecommendationWorldCandidate. */
export interface EngagementCandidate {
  id: string;
  publishedAt?: Date | null;
  createdAt?: Date | null;
  tags?: string[] | null;
  downloadCount?: number;
  favoriteCount?: number;
  messageCount?: number;
  reviewCount?: number;
  averageRating?: number;
  hasAudio?: boolean | null;
  customUiLoc?: number | null;
  totalTokens?: number | null;
  embedding?: number[] | null;
  /** Recall routes that surfaced this candidate (e.g. "co_played"). */
  candidateSource?: string[];
}

function candidateAgeDays(candidate: EngagementCandidate, now: Date): number {
  const born = candidate.publishedAt ?? candidate.createdAt;
  return born ? Math.max(0, (now.getTime() - born.getTime()) / 86_400_000) : 9999;
}

/**
 * Feature map for the learned ranker. NAMES ARE A CONTRACT with
 * trainer/train.py — change them in both places or the model scores
 * garbage. All numeric; position is 0 at serving (the YouTube trick:
 * trained with real positions so the model learns the bias, served with a
 * constant so ranking is position-free).
 */
export function buildRankerFeatures(
  candidate: EngagementCandidate,
  stat: WorldEngagementStat | undefined,
  ctx: EngagementContext,
  now: Date,
): Record<string, number> {
  const ageDays = candidateAgeDays(candidate, now);
  const imp7 = stat?.impressions7d ?? 0;
  let ctrLift = 0;
  if (stat && imp7 >= CTR_MIN_IMPRESSIONS && ctx.globals.ctr > 0) {
    const smoothed = (stat.clicks7d + CTR_PRIOR_IMPRESSIONS * ctx.globals.ctr) / (imp7 + CTR_PRIOR_IMPRESSIONS);
    ctrLift = clampLn(smoothed / ctx.globals.ctr, -2, 2);
  }
  const qualifiedRate = stat && stat.playsStarted7d > 0
    ? (stat.qualifiedPlays7d + QUALITY_PRIOR_PLAYS * ctx.globals.qualifiedRate) /
      (stat.playsStarted7d + QUALITY_PRIOR_PLAYS)
    : ctx.globals.qualifiedRate;
  const velocityLn = stat ? clampLn((stat.playsStarted7d + 3) / (stat.playsPrev7d + 3), -2, 2) : 0;
  const reviewCount = candidate.reviewCount ?? 0;
  const ratingConf = Math.min(8, (candidate.averageRating ?? 0) * 3 * Math.sqrt(reviewCount / 10));
  const uiTier = customUiTier(candidate.customUiLoc);
  const craft = ctx.craft;

  // History with this exact card (v3). Hours are capped at 30 days; "never"
  // sits at the cap so a first showing and a month-old one look alike.
  const exposure = ctx.exposure.get(candidate.id);
  const hoursSince = (at: number | null | undefined) =>
    at == null ? EXPOSURE_HOURS_CAP : Math.min(EXPOSURE_HOURS_CAP, Math.max(0, (now.getTime() - at) / 3_600_000));
  const hoursSinceImpression = hoursSince(exposure?.lastImpressionAt);
  const hoursSinceClick = hoursSince(exposure?.lastClickAt);
  // Similarity terms the v1 heuristics add outside the model (v3 feeds them in
  // as raw cosines so the trees learn when each one matters).
  const embedding = candidate.embedding && candidate.embedding.length ? l2Normalize(candidate.embedding) : null;
  const worldLatent = ctx.userLatent ? ctx.worldLatent.get(candidate.id) : undefined;
  const alsKnown = Boolean(ctx.userLatent && worldLatent && worldLatent.length === ctx.userLatent.length);
  const tasteKnown = Boolean(embedding && ctx.tasteCentroid && ctx.tasteCentroid.length === embedding.length);
  const sessionKnown = Boolean(embedding && ctx.sessionCentroid && ctx.sessionCentroid.length === embedding.length);
  let sessionTagOverlap = 0;
  if (ctx.sessionTags.size > 0 && Array.isArray(candidate.tags)) {
    for (const tag of candidate.tags) if (ctx.sessionTags.has(tag.trim().toLowerCase())) sessionTagOverlap += 1;
  }
  const source = (name: string) => (candidate.candidateSource?.includes(name) ? 1 : 0);
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;

  return {
    position: 0,
    surf_recommended: 1,
    surf_newest: 0,
    surf_popular: 0,
    surf_search: 0,
    surf_category: 0,
    surf_following: 0,
    tier_cold: ctx.tier === "cold" ? 1 : 0,
    tier_warm: ctx.tier === "warm" ? 1 : 0,
    tier_mature: ctx.tier === "mature" ? 1 : 0,
    log1p_imp7d: Math.log1p(imp7),
    ctr_lift_ln: ctrLift,
    log1p_plays7d: Math.log1p(stat?.playsStarted7d ?? 0),
    qualified_rate_sm: qualifiedRate,
    velocity_ln: velocityLn,
    log1p_imp_total: Math.log1p(stat?.impressionsTotal ?? 0),
    log1p_favorites: Math.log1p(candidate.favoriteCount ?? 0),
    log1p_messages: Math.log1p(candidate.messageCount ?? 0),
    log1p_downloads: Math.log1p(candidate.downloadCount ?? 0),
    age_days_capped: Math.min(ageDays, 365),
    freshness: Math.pow(0.5, ageDays / 14),
    has_audio: candidate.hasAudio ? 1 : 0,
    custom_ui_tier: uiTier,
    rating_conf: ratingConf,
    log1p_total_tokens: Math.log1p(candidate.totalTokens ?? 0),
    // User craft taste (revealed, not declared) — the trees learn the
    // interaction "heavy-UI lovers × heavy-UI card" from these plus the
    // item-side custom_ui_tier / has_audio / log1p_total_tokens above.
    user_ui_pref: craft?.uiTier ?? 0,
    user_audio_pref: craft?.audio ?? 0,
    user_log_token_pref: craft?.logTokens ?? 0,
    user_craft_known: craft && craft.sampleSize >= CRAFT_MIN_SAMPLE ? 1 : 0,
    // ── v3: this user's history with this card ──
    exp_seen_before: exposure && exposure.impressions30d > 0 ? 1 : 0,
    exp_impressions_7d_log1p: Math.log1p(exposure?.impressions7d ?? 0),
    exp_impressions_30d_log1p: Math.log1p(exposure?.impressions30d ?? 0),
    exp_hours_since_impression: hoursSinceImpression,
    exp_seen_last_hour: hoursSinceImpression < 1 ? 1 : 0,
    exp_unclicked_14d: exposure && exposure.clicks14d === 0 ? exposure.impressions14d : 0,
    exp_clicked_before: exposure && exposure.clicks30d > 0 ? 1 : 0,
    exp_clicks_30d: exposure?.clicks30d ?? 0,
    exp_hours_since_click: hoursSinceClick,
    // ── v3: similarity, as raw cosines ──
    als_cosine: alsKnown ? dot(ctx.userLatent!, worldLatent!) : 0,
    als_known: alsKnown ? 1 : 0,
    taste_cosine: tasteKnown ? dot(ctx.tasteCentroid!, embedding!) : 0,
    taste_known: tasteKnown ? 1 : 0,
    session_cosine: sessionKnown ? dot(ctx.sessionCentroid!, embedding!) : 0,
    session_tag_overlap: Math.min(SESSION_TAG_OVERLAP_CAP, sessionTagOverlap),
    // ── v3: which recall routes surfaced the card ──
    src_co_played: source("co_played"),
    src_similar_played: source("similar_played"),
    src_creator_affinity: source("creator_affinity"),
    src_followed_recent: source("followed_recent"),
    src_popular_recent: source("popular_recent"),
    // ── v3: user and context ──
    user_signal_count_log1p: Math.log1p(Math.max(0, ctx.profileSignalCount)),
    hour_sin: Math.sin((2 * Math.PI * hour) / 24),
    hour_cos: Math.cos((2 * Math.PI * hour) / 24),
    weekday_utc: now.getUTCDay(),
  };
}

/** Feature-time caps for the v3 history inputs. */
const EXPOSURE_HOURS_CAP = 24 * 30;
const SESSION_TAG_OVERLAP_CAP = 5;

/**
 * Compute the engagement contribution for one candidate. Pure and
 * deterministic for a given (candidate, ctx, now-day) — required so the
 * server-side Redis feed cache and visit ordering stay coherent.
 *
 * `ctx` undefined or control arm → all zeros (control must score
 * byte-identically to the pre-Ship-1 formula).
 */
export function scoreEngagement(
  candidate: EngagementCandidate,
  ctx: EngagementContext | undefined,
  now: Date,
): EngagementBreakdown {
  if (!ctx || ctx.variant === "control") return EMPTY_ENGAGEMENT_BREAKDOWN;

  const stat = ctx.stats.get(candidate.id);
  const useModel = ctx.variant === "engage_v2" && ctx.model !== null;

  // ── Learned model (v2) — replaces the ctr/quality/velocity heuristics
  // (they're its input features; keeping them too would double-count).
  let model = 0;
  let modelApplied = false;
  let ctr = 0;
  let quality = 0;
  let velocity = 0;
  if (useModel) {
    try {
      const raw = ctx.model!.predict(buildRankerFeatures(candidate, stat, ctx, now));
      if (ctx.model!.kind === "regression" || ctx.model!.kind === "tweedie") {
        // regression: raw = predicted log1p(minutes). tweedie: the handle
        // already returns expected minutes. Lift = predicted minutes vs the
        // model's average-world baseline (the time-value objective).
        const predictedMin = ctx.model!.kind === "tweedie" ? raw : Math.expm1(raw);
        const baseline = ctx.model!.valueBaseline;
        model = MODEL_WEIGHT * clampLn(
          (predictedMin + MODEL_VALUE_PRIOR_MIN) / (baseline + MODEL_VALUE_PRIOR_MIN),
          MODEL_LN_MIN,
          MODEL_LN_MAX,
        );
      } else {
        // Legacy binary model: raw = P(click); lift vs global click prior.
        const p0 = Math.max(ctx.globals.ctr, 0.005);
        model = MODEL_WEIGHT * clampLn(raw / p0, MODEL_LN_MIN, MODEL_LN_MAX);
      }
      modelApplied = true;
    } catch {
      // A single bad prediction must never break the feed — score as v1.
      model = 0;
      modelApplied = false;
    }
  }
  if (!modelApplied) {
    if (stat && stat.impressions7d >= CTR_MIN_IMPRESSIONS && ctx.globals.ctr > 0) {
      const smoothed =
        (stat.clicks7d + CTR_PRIOR_IMPRESSIONS * ctx.globals.ctr) /
        (stat.impressions7d + CTR_PRIOR_IMPRESSIONS);
      ctr = CTR_WEIGHT * clampLn(smoothed / ctx.globals.ctr, CTR_LN_MIN, CTR_LN_MAX);
    }
    if (stat && stat.playsStarted7d >= QUALITY_MIN_PLAYS && ctx.globals.qualifiedRate > 0) {
      const smoothed =
        (stat.qualifiedPlays7d + QUALITY_PRIOR_PLAYS * ctx.globals.qualifiedRate) /
        (stat.playsStarted7d + QUALITY_PRIOR_PLAYS);
      quality = QUALITY_WEIGHT * clampLn(smoothed / ctx.globals.qualifiedRate, QUALITY_LN_MIN, QUALITY_LN_MAX);
    }
    if (stat && stat.playsStarted7d + stat.playsPrev7d >= VELOCITY_MIN_TOTAL_PLAYS) {
      velocity = VELOCITY_WEIGHT * clampLn(
        (stat.playsStarted7d + 3) / (stat.playsPrev7d + 3),
        VELOCITY_LN_MIN,
        VELOCITY_LN_MAX,
      );
    }
  }

  // Fatigue follows the measured decay of a card's click rate with repeated
  // unclicked showings (fatigueKeep); ctx.fatigue keeps the legacy threshold
  // map for the exposure_unclicked_impressions snapshot input only.
  const fatiguePenalty = fatigueDiscount(ctx.exposure.get(candidate.id));

  // Exploration moved OUT of the additive score (owner decision
  // 2026-08-19): an unproven card must never buy its way into premium top
  // slots. Instead injectDeepExploration() in recommendations.ts pulls
  // eligible newcomers into deep scroll positions, scaled by user tenure —
  // the TikTok doctrine (new users get proven content; invested scrollers
  // carry the exploration budget). The field now carries the per-visit
  // rotation jitter (2026-08-20): zero-mean seeded noise that reorders
  // cards within quality neighborhoods so each visit's feed is fresh.
  let explore = 0;
  if (ctx.rotationSeed) {
    explore = ROTATION_JITTER * (2 * fnvHash01(`${ctx.rotationSeed}:rot:${candidate.id}`) - 1);
  }

  // ── Session adaptation (v1 + v2): boost candidates similar to what the
  // user tapped in the last ~45 minutes. This is the no-quiz cold start —
  // the second page already knows what the first page taught us.
  let session = 0;
  if (ctx.sessionCentroid && candidate.embedding && candidate.embedding.length === ctx.sessionCentroid.length) {
    const normalized = l2Normalize(candidate.embedding);
    if (normalized) {
      const cos = dot(ctx.sessionCentroid, normalized);
      const range = SESSION_COSINE_CAP - SESSION_COSINE_FLOOR;
      const adjusted = Math.max(0, Math.min(1, (cos - SESSION_COSINE_FLOOR) / range));
      session += SESSION_VECTOR_WEIGHT * adjusted * adjusted;
    }
  }
  if (ctx.sessionTags.size > 0 && Array.isArray(candidate.tags) && candidate.tags.length > 0) {
    let shared = 0;
    for (const tag of candidate.tags) {
      if (ctx.sessionTags.has(tag.trim().toLowerCase())) shared += 1;
    }
    session += SESSION_TAG_WEIGHT * Math.min(SESSION_TAG_CAP, shared);
  }

  // ── Craft-taste match (v1 + v2): boost candidates whose production
  // level matches what this user demonstrably plays — inferred, never
  // asked. Signed match: a minimalist's feed demotes heavy-UI cards just
  // as a craft-lover's feed lifts them.
  let craft = 0;
  if (ctx.craft && ctx.craft.sampleSize >= CRAFT_MIN_SAMPLE) {
    const itemTier = customUiTier(candidate.customUiLoc);
    craft += CRAFT_UI_WEIGHT * (1 - Math.abs(ctx.craft.uiTier - itemTier) / 3 - 0.5);
    craft += CRAFT_AUDIO_WEIGHT * (ctx.craft.audio - 0.5) * (candidate.hasAudio ? 1 : -1);
    const tokenGap = Math.min(
      1,
      Math.abs(ctx.craft.logTokens - Math.log1p(candidate.totalTokens ?? 0)) / CRAFT_TOKEN_GAP_SCALE,
    );
    craft += CRAFT_TOKEN_WEIGHT * (1 - tokenGap - 0.5);
  }

  // ── Co-play affinity (v1 + v2): "players like you play this" — folded
  // into the grid ranking rather than shown as a labeled shelf.
  const coPlay = candidate.candidateSource?.includes("co_played") ? CO_PLAY_BONUS : 0;

  // ── Behavioral latent affinity (v1 + v2): dot product of the user's and
  // the world's ALS latent vectors (both unit-normalized → cosine). This is
  // the collaborative-filtering "understands taste in a shared space" signal
  // — it surfaces worlds the user's latent taste matches even when no tag,
  // creator, or content-embedding connection exists. New/low-play worlds
  // have no latent vector; the content vectorScore term handles those.
  let latent = 0;
  if (ctx.userLatent) {
    const worldVec = ctx.worldLatent.get(candidate.id);
    if (worldVec && worldVec.length === ctx.userLatent.length) {
      const cos = dot(ctx.userLatent, worldVec); // both already unit-normalized
      const range = LATENT_COSINE_CAP - LATENT_COSINE_FLOOR;
      const adjusted = Math.max(0, Math.min(1, (cos - LATENT_COSINE_FLOOR) / range));
      latent = LATENT_WEIGHT * adjusted * adjusted;
    }
  }

  return {
    ctr,
    quality,
    velocity,
    fatiguePenalty,
    explore,
    session,
    craft,
    coPlay,
    model,
    latent,
    total: ctr + quality + velocity + explore + session + craft + coPlay + model + latent - fatiguePenalty,
  };
}

// ─── Context loading (per feed request, heavily cached) ──────────────

// v2: snapshot gained returners_30d + total_play_minutes_30d (retention-proven
// cold-start). Bumped so a post-deploy read can't get an old-shape blob.
const STATS_CACHE_KEY = "rec:engstats:v2";
const STATS_CACHE_TTL_SEC = 300;
const FATIGUE_CACHE_PREFIX = "rec:fatigue:";
const FATIGUE_WINDOW_DAYS = 14;
const EXPOSURE_CACHE_PREFIX = "rec:exposure:v1:";
const EXPOSURE_CACHE_TTL_SEC = 600;
const EXPOSURE_WINDOW_DAYS = 30;
const DISMISS_CACHE_PREFIX = "rec:dismiss:";
const DISMISS_CACHE_TTL_SEC = 300;

/** One warn per boot per failure site — the stats table may legitimately
 * not exist yet on an environment that hasn't run the Ship-1 DDL. */
const warnedOnce = new Set<string>();
function warnOnce(site: string, err: unknown): void {
  if (warnedOnce.has(site)) return;
  warnedOnce.add(site);
  console.warn(`[engagement] ${site} unavailable (using cached or empty fallback):`, err instanceof Error ? err.message : err);
}

export function emptyEngagementContext(variant: FeedVariant): EngagementContext {
  return {
    variant,
    stats: new Map(),
    globals: { ctr: 0, qualifiedRate: 0 },
    fatigue: new Map(),
    exposure: new Map(),
    dismissedWorldIds: new Set(),
    sessionCentroid: null,
    sessionTags: new Set(),
    tasteCentroid: null,
    profileSignalCount: 0,
    tier: null,
    craft: null,
    model: null,
    userLatent: null,
    worldLatent: new Map(),
    rotationSeed: null,
  };
}

interface StatsSnapshot {
  rows: WorldEngagementStat[];
  globals: EngagementGlobals;
}

interface WorldLatentSnapshot {
  /** Exact SQL epoch microseconds identifying the trainer transaction. */
  updatedAt: string | null;
  factors: Map<string, number[]>;
}
interface UserLatentSnapshot {
  updatedAt: string;
  factors: number[];
}
const emptyWorldLatentSnapshot = (): WorldLatentSnapshot => ({ updatedAt: null, factors: new Map() });
const isLatentGeneration = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);

// Short L1 freshness bounds cross-replica invalidation lag. Last-good values
// survive source errors for at most five minutes from their successful load;
// failures/empty sources retry after one second, without a polling timer.
// Separate DB handles never share snapshots. Each cache retains at most four
// sources and 16 MiB of accounted payload; oversized loads are not cached.
const snapshotCacheOptions = { freshMs: 5_000, negativeMs: 1_000, maxStaleMs: 300_000,
  maxEntries: 4, maxBytes: 16 * 1024 * 1024 };
const statsSnapshots = new EngagementSnapshotCache<StatsSnapshot>({ ...snapshotCacheOptions,
  empty: () => ({ rows: [], globals: { ctr: 0, qualifiedRate: 0 } }),
  isEmpty: value => value.rows.length === 0,
  sizeOf: value => Buffer.byteLength(JSON.stringify(value)) + value.rows.length * 256,
});
const latentSnapshots = new EngagementSnapshotCache<WorldLatentSnapshot>({ ...snapshotCacheOptions,
  empty: emptyWorldLatentSnapshot, isEmpty: value => value.factors.size === 0,
  sizeOf: value => [...value.factors].reduce((bytes, [id, factors]) => bytes + id.length * 2 + factors.length * 8 + 128,
    (value.updatedAt?.length ?? 0) * 2),
});

function loadStatsSnapshot(db: Database): Promise<StatsSnapshot> {
  return statsSnapshots.get(db, async () => {
    const snapshot = await readStatsSnapshot(db);
    // Freeze once per source load, including Redis hits, rather than copying
    // every public row into every concurrent request.
    for (const row of snapshot.rows) Object.freeze(row);
    return snapshot;
  });
}

async function readStatsSnapshot(db: Database): Promise<StatsSnapshot> {
  if (redis) {
    try {
      const cached = await redis.get(STATS_CACHE_KEY);
      if (cached) return JSON.parse(cached) as StatsSnapshot;
    } catch { /* fall through to DB */ }
  }

  let rows: WorldEngagementStat[] = [];
  try {
    const result = await db.execute(sql`
      SELECT world_id, impressions_7d, clicks_7d, plays_started_7d,
             qualified_plays_7d, plays_prev_7d, impressions_total, clicks_total,
             returners_30d, total_play_minutes_30d,
             EXTRACT(EPOCH FROM updated_at AT TIME ZONE 'UTC') * 1000 AS updated_at_ms
      FROM world_engagement_stats
    `);
    const raw = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    rows = raw.map((r) => ({
      worldId: String(r.world_id),
      ...(r.updated_at_ms != null && Number.isFinite(Number(r.updated_at_ms))
        ? { updatedAt: new Date(Number(r.updated_at_ms)).toISOString() } : {}),
      impressions7d: Number(r.impressions_7d ?? 0),
      clicks7d: Number(r.clicks_7d ?? 0),
      playsStarted7d: Number(r.plays_started_7d ?? 0),
      qualifiedPlays7d: Number(r.qualified_plays_7d ?? 0),
      playsPrev7d: Number(r.plays_prev_7d ?? 0),
      impressionsTotal: Number(r.impressions_total ?? 0),
      clicksTotal: Number(r.clicks_total ?? 0),
      returners30d: Number(r.returners_30d ?? 0),
      totalPlayMinutes30d: Number(r.total_play_minutes_30d ?? 0),
    }));
  } catch (err) {
    warnOnce("world_engagement_stats", err);
    throw err; // The bounded local cache supplies last-good or empty fallback.
  }

  let imp = 0, clk = 0, starts = 0, qualified = 0;
  for (const r of rows) {
    imp += r.impressions7d;
    clk += r.clicks7d;
    starts += r.playsStarted7d;
    qualified += r.qualifiedPlays7d;
  }
  const snapshot: StatsSnapshot = {
    rows,
    globals: {
      ctr: imp > 0 ? clk / imp : 0,
      qualifiedRate: starts > 0 ? qualified / starts : 0,
    },
  };

  if (redis && rows.length > 0) {
    // Local single-flight coalesces readers in this process. NX suppresses
    // duplicate writes from other replicas; it is not a distributed read lock.
    redis.set(STATS_CACHE_KEY, JSON.stringify(snapshot), "EX", STATS_CACHE_TTL_SEC, "NX").catch(() => {});
  }
  return snapshot;
}

// v1 had no publication generation and must never be consumed by this reader.
const LATENT_CACHE_KEY = "rec:latent:v2";
const LATENT_CACHE_TTL_SEC = 600; // ALS refreshes nightly; 10-min snapshot is plenty.

/** One coherent ALS publication across the cached world vectors. */
function loadWorldLatentSnapshot(db: Database): Promise<WorldLatentSnapshot> {
  return latentSnapshots.get(db, () => readWorldLatentSnapshot(db));
}

async function readWorldLatentSnapshot(db: Database, refresh = false): Promise<WorldLatentSnapshot> {
  if (redis && !refresh) {
    try {
      const cached = await redis.get(LATENT_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { updatedAt?: unknown; factors?: unknown };
        if (isLatentGeneration(parsed?.updatedAt) && parsed.factors && typeof parsed.factors === "object" && !Array.isArray(parsed.factors)) {
          const entries = Object.entries(parsed.factors);
          if (entries.every(([, factors]) => Array.isArray(factors) && factors.every(Number.isFinite))) {
            for (const [, factors] of entries) Object.freeze(factors);
            return { updatedAt: parsed.updatedAt, factors: new Map(entries as Array<[string, number[]]>) };
          }
        }
      }
    } catch { /* fall through */ }
  }
  const map = new Map<string, number[]>();
  let updatedAt: string | null = null;
  try {
    // SQL preserves all six fractional digits. Date/Number conversion in JS
    // would collapse distinct publications within one millisecond.
    const result = await db.execute(sql`SELECT world_id, factors,
      (EXTRACT(EPOCH FROM updated_at) * 1000000)::bigint::text AS updated_at FROM world_latent_factors`);
    const raw = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    for (const r of raw) {
      // A pre-atomic or malformed publication is not a coherent latent basis.
      if (!isLatentGeneration(r.updated_at) || (updatedAt !== null && updatedAt !== r.updated_at)) return emptyWorldLatentSnapshot();
      updatedAt = r.updated_at;
      const f = Array.isArray(r.factors)
        ? (r.factors as number[])
        : typeof r.factors === "string"
          ? (JSON.parse(r.factors) as number[])
          : null;
      if (Array.isArray(f) && f.every(Number.isFinite)) {
        Object.freeze(f);
        map.set(String(r.world_id), f);
      }
    }
  } catch (err) {
    warnOnce("world_latent_factors", err);
    throw err;
  }
  if (redis && map.size > 0) {
    const payload = JSON.stringify({ updatedAt, factors: Object.fromEntries(map) });
    // Mismatch refresh bypasses and replaces the old Redis basis. Other
    // replicas may race this write, so generation checks remain mandatory.
    const write = refresh ? redis.set(LATENT_CACHE_KEY, payload, "EX", LATENT_CACHE_TTL_SEC)
      : redis.set(LATENT_CACHE_KEY, payload, "EX", LATENT_CACHE_TTL_SEC, "NX");
    write.catch(() => {});
  }
  return { updatedAt, factors: map };
}

/** One user's ALS latent vector (single PK lookup), or null if they weren't
 * in the factorization (guest / too few plays). */
async function loadUserLatent(db: Database, userId: string): Promise<UserLatentSnapshot | null> {
  try {
    const result = await db.execute(sql`SELECT factors,
      (EXTRACT(EPOCH FROM updated_at) * 1000000)::bigint::text AS updated_at FROM user_latent_factors WHERE user_id = ${userId}`);
    const raw = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    if (raw.length === 0) return null;
    const f = raw[0]!.factors;
    const arr = Array.isArray(f) ? (f as number[]) : typeof f === "string" ? (JSON.parse(f) as number[]) : null;
    return Array.isArray(arr) && arr.every(Number.isFinite) && isLatentGeneration(raw[0]!.updated_at)
      ? { factors: arr, updatedAt: raw[0]!.updated_at } : null;
  } catch (err) {
    warnOnce("user_latent_factors", err);
    return null;
  }
}

/** Compact cache row: [imp7, imp14, imp30, clk14, clk30, lastImpMs, lastClkMs]. */
type ExposureRow = [number, number, number, number, number, number, number];

function exposureFromRow(row: ExposureRow): ExposureStat {
  return {
    impressions7d: row[0], impressions14d: row[1], impressions30d: row[2],
    clicks14d: row[3], clicks30d: row[4],
    lastImpressionAt: row[5] > 0 ? row[5] : null, lastClickAt: row[6] > 0 ? row[6] : null,
  };
}

/** This user's history with every card our feed log has shown them in the
 * last 30 days. One grouped read on the (user_id, created_at) index, cached
 * briefly; the click beacon purges it so the next page sees the tap. */
async function loadExposureMap(db: Database, userId: string): Promise<Map<string, ExposureStat>> {
  const cacheKey = EXPOSURE_CACHE_PREFIX + userId;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as Record<string, ExposureRow>;
        return new Map(Object.entries(parsed).map(([id, row]) => [id, exposureFromRow(row)]));
      }
    } catch { /* fall through */ }
  }

  const entries: Record<string, ExposureRow> = {};
  try {
    const result = await db.execute(sql`
      SELECT world_id,
             COUNT(*) FILTER (WHERE event_type = 'impression' AND created_at > now() - interval '7 days') AS imp7,
             COUNT(*) FILTER (WHERE event_type = 'impression' AND created_at > now() - (${FATIGUE_WINDOW_DAYS}::int * interval '1 day')) AS imp14,
             COUNT(*) FILTER (WHERE event_type = 'impression') AS imp30,
             COUNT(*) FILTER (WHERE event_type IN ('click', 'play') AND created_at > now() - (${FATIGUE_WINDOW_DAYS}::int * interval '1 day')) AS clk14,
             COUNT(*) FILTER (WHERE event_type IN ('click', 'play')) AS clk30,
             MAX(created_at) FILTER (WHERE event_type = 'impression') AS last_imp,
             MAX(created_at) FILTER (WHERE event_type IN ('click', 'play')) AS last_clk
      FROM feed_events
      WHERE user_id = ${userId}
        AND created_at > now() - (${EXPOSURE_WINDOW_DAYS}::int * interval '1 day')
      GROUP BY world_id
    `);
    const raw = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    const ms = (value: unknown) => {
      const t = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
      return Number.isFinite(t) ? t : 0;
    };
    for (const r of raw) {
      entries[String(r.world_id)] = [Number(r.imp7 ?? 0), Number(r.imp14 ?? 0), Number(r.imp30 ?? 0),
        Number(r.clk14 ?? 0), Number(r.clk30 ?? 0), ms(r.last_imp), ms(r.last_clk)];
    }
  } catch (err) {
    warnOnce("feed_events(exposure)", err);
  }

  if (redis) {
    redis.set(cacheKey, JSON.stringify(entries), "EX", EXPOSURE_CACHE_TTL_SEC).catch(() => {});
  }
  return new Map(Object.entries(entries).map(([id, row]) => [id, exposureFromRow(row)]));
}

/** The v1 fatigue map, unchanged in meaning: worlds this user saw at least
 * FATIGUE_LIGHT_IMPRESSIONS times in 14 days and never clicked or played. */
export function fatigueFromExposure(exposure: Map<string, ExposureStat>): Map<string, number> {
  const fatigue = new Map<string, number>();
  for (const [worldId, stat] of exposure) {
    if (stat.impressions14d >= FATIGUE_LIGHT_IMPRESSIONS && stat.clicks14d === 0) fatigue.set(worldId, stat.impressions14d);
  }
  return fatigue;
}

async function loadDismissedWorldIds(db: Database, userId: string): Promise<Set<string>> {
  const cacheKey = DISMISS_CACHE_PREFIX + userId;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return new Set(JSON.parse(cached) as string[]);
    } catch { /* fall through */ }
  }

  let ids: string[] = [];
  try {
    const result = await db.execute(sql`
      SELECT world_id FROM world_dismissals WHERE user_id = ${userId}
    `);
    const raw = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    ids = raw.map((r) => String(r.world_id));
  } catch (err) {
    warnOnce("world_dismissals", err);
    ids = [];
  }

  if (redis) {
    redis.set(cacheKey, JSON.stringify(ids), "EX", DISMISS_CACHE_TTL_SEC).catch(() => {});
  }
  return new Set(ids);
}

/**
 * Session-level adaptation signals: the worlds this user clicked/played in
 * the last SESSION_WINDOW_MINUTES (from our own feed_events log), reduced
 * to a unit embedding centroid + tag union. Deliberately NOT Redis-cached:
 * freshness is the whole point, and the click beacon invalidates the feed
 * cache so this runs on the very next page load after a tap.
 */
/** Who the 45-minute session belongs to. Accounts tap through the feed
 * beacon (feed_events, keyed by user). Guests have no user row; their taps
 * live in the discovery log keyed by actor (`guest:<uuid>`), indexed by
 * (actor_id, occurred_at). Either way the same centroid + tag terms apply,
 * so a guest's second page leans toward the first page's tap (2026-09-24). */
export type SessionSubject = { userId: string } | { actorId: string };

async function loadSessionSignals(
  db: Database,
  subject: SessionSubject,
): Promise<{ centroid: number[] | null; tags: Set<string> }> {
  const none = { centroid: null, tags: new Set<string>() };
  let worldIds: string[] = [];
  try {
    const result = await db.execute("userId" in subject ? sql`
      SELECT world_id
      FROM feed_events
      WHERE user_id = ${subject.userId}
        AND event_type IN ('click', 'play')
        AND created_at > now() - (${SESSION_WINDOW_MINUTES}::int * interval '1 minute')
      GROUP BY world_id
      ORDER BY MAX(created_at) DESC
      LIMIT ${SESSION_MAX_WORLDS}
    ` : sql`
      SELECT world_id
      FROM discovery_events
      WHERE actor_id = ${subject.actorId}
        AND event_type IN ('click', 'play_intent')
        AND occurred_at > now() - (${SESSION_WINDOW_MINUTES}::int * interval '1 minute')
        AND world_id <> ''
      GROUP BY world_id
      ORDER BY MAX(occurred_at) DESC
      LIMIT ${SESSION_MAX_WORLDS}
    `);
    const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    worldIds = rows.map((r) => String(r.world_id));
  } catch (err) {
    warnOnce("userId" in subject ? "feed_events(session)" : "discovery_events(session)", err);
    return none;
  }
  if (worldIds.length === 0) return none;

  try {
    // Same drizzle gotcha as the co_played route: a raw JS-array param
    // serializes as a JSON string, so ANY() needs an explicit ARRAY[].
    const idArray = sql`ARRAY[${sql.join(worldIds.map((id) => sql`${id}`), sql`,`)}]::text[]`;
    const result = await db.execute(sql`
      SELECT tags, embedding FROM worlds WHERE id = ANY(${idArray})
    `);
    const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
    const tags = new Set<string>();
    const sum: number[] = [];
    let contributions = 0;
    for (const row of rows) {
      const rowTags = Array.isArray(row.tags) ? (row.tags as string[]) : [];
      for (const t of rowTags) {
        const normalized = String(t).trim().toLowerCase();
        if (normalized) tags.add(normalized);
      }
      const vec = parseVec(row.embedding);
      const normalized = vec ? l2Normalize(vec) : null;
      if (normalized) {
        if (sum.length === 0) sum.push(...normalized);
        else if (sum.length === normalized.length) {
          for (let i = 0; i < sum.length; i++) sum[i]! += normalized[i]!;
        }
        contributions += 1;
      }
    }
    const centroid = contributions > 0 ? l2Normalize(sum) : null;
    return { centroid, tags };
  } catch (err) {
    warnOnce("worlds(session-embeddings)", err);
    return none;
  }
}

/**
 * Load everything the ranker needs beyond the taste profile. Dismissals
 * load for BOTH arms (product behavior, not an experiment); stats, fatigue
 * and session signals only for the treatment arms (control must score
 * byte-identically to pre-Ship-1). All failures degrade to empty
 * structures. `model` is attached only on engage_v2.
 */
export async function loadEngagementContext(
  db: Database,
  userId: string | null,
  variant: FeedVariant,
  opts?: { model?: RankerModelHandle | null; rotationSeed?: string | null; actor?: string | null },
): Promise<EngagementContext> {
  const treatment = variant !== "control";
  // A guest's session taste comes from the discovery log by actor id.
  const guestActor = !userId && opts?.actor && opts.actor.startsWith("guest:") ? opts.actor : null;
  const [dismissed, snapshot, exposure, session, worldLatent, userLatent] = await Promise.all([
    userId ? loadDismissedWorldIds(db, userId) : Promise.resolve(new Set<string>()),
    treatment ? loadStatsSnapshot(db) : Promise.resolve<StatsSnapshot | null>(null),
    treatment && userId ? loadExposureMap(db, userId) : Promise.resolve(new Map<string, ExposureStat>()),
    treatment && userId ? loadSessionSignals(db, { userId })
      : treatment && guestActor ? loadSessionSignals(db, { actorId: guestActor })
      : Promise.resolve({ centroid: null, tags: new Set<string>() }),
    // Guests have no user vector, so world factors cannot affect their score.
    treatment && userId ? loadWorldLatentSnapshot(db) : Promise.resolve(emptyWorldLatentSnapshot()),
    treatment && userId ? loadUserLatent(db, userId) : Promise.resolve<UserLatentSnapshot | null>(null),
  ]);

  let matchingWorldLatent = worldLatent;
  if (userLatent && worldLatent.updatedAt && worldLatent.updatedAt !== userLatent.updatedAt) {
    matchingWorldLatent = await latentSnapshots.refresh(db, worldLatent, () => readWorldLatentSnapshot(db, true));
  }
  const ctx = emptyEngagementContext(variant);
  ctx.dismissedWorldIds = dismissed;
  ctx.exposure = exposure;
  ctx.fatigue = fatigueFromExposure(exposure);
  ctx.sessionCentroid = session.centroid;
  ctx.sessionTags = session.tags;
  // Independent reads can straddle an atomic trainer commit. Only a coherent
  // pair reaches scoring; stale/error fallbacks must pass the same check.
  if (userLatent && matchingWorldLatent.updatedAt === userLatent.updatedAt) {
    ctx.worldLatent = new Map(matchingWorldLatent.factors);
    ctx.userLatent = [...userLatent.factors];
  }
  // ctx.tier and ctx.craft are attached by the handler once the profile
  // (loaded in parallel) resolves.
  if (variant === "engage_v2") ctx.model = opts?.model ?? null;
  if (treatment) ctx.rotationSeed = opts?.rotationSeed ?? null;
  if (snapshot) {
    ctx.globals = { ...snapshot.globals };
    for (const row of snapshot.rows) ctx.stats.set(row.worldId, row);
  }
  return ctx;
}

/** Purge a user's dismissal + fatigue caches (call on dismiss/undo). */
export async function invalidateUserEngagementCaches(userId: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(DISMISS_CACHE_PREFIX + userId, FATIGUE_CACHE_PREFIX + userId, EXPOSURE_CACHE_PREFIX + userId);
  } catch { /* self-expires */ }
}

/** Purge the shared stats snapshot (call after each rollup refresh). */
export async function invalidateEngagementStatsCache(): Promise<void> {
  statsSnapshots.invalidate();
  if (!redis) return;
  try {
    await redis.del(STATS_CACHE_KEY);
  } catch { /* self-expires */ }
}
