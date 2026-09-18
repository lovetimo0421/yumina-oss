/**
 * Support-prompt scoring.
 *
 * Decides whether a player has played a world deeply enough that offering to
 * support its creator is welcome rather than intrusive. Pure and dependency
 * free so the thresholds can be reasoned about and tested on their own; every
 * frequency cap and suppression rule lives in routes/support-prompt.ts.
 *
 * Three axes, combined as a weighted geometric mean:
 *
 *   depth = t^0.45 · m^0.35 · d^0.20
 *
 * The geometric mean is the point. A weighted SUM would let one axis carry the
 * whole score, so a tab left open for three hours with zero turns, or a burst
 * of forty turns in two minutes, would qualify. A product cannot: any axis at
 * zero takes the score to zero, so "deep" always means time AND turns AND (to a
 * lesser degree) coming back.
 *
 * Affinity compares the world against the player's OWN history rather than
 * against other players. That avoids a cross-user rollup job, adapts to heavy
 * and light players alike, and asks the question that actually predicts
 * support: is this one of the worlds that matters to you?
 */

/** Active minutes that count as a full score on the time axis. */
const TARGET_MINUTES = 45;
/** Player turns that count as a full score on the depth axis. */
const TARGET_TURNS = 40;
/** Distinct days played that count as a full score on the return axis. */
const TARGET_DAYS = 3;

const WEIGHT_TIME = 0.45;
const WEIGHT_TURNS = 0.35;
const WEIGHT_DAYS = 0.2;

/** Below either floor the session is too small to ask about, whatever the ratios. */
const FLOOR_MINUTES = 20;
const FLOOR_TURNS = 15;

/** Exported so callers can bail before running the queries that feed the score. */
export const SUPPORT_PROMPT_FLOOR_SECONDS = FLOOR_MINUTES * 60;
export const SUPPORT_PROMPT_FLOOR_TURNS = FLOOR_TURNS;

/** A world in the player's top rank tier scores full affinity. */
const FAVOURITE_TOP_N = 3;
const FAVOURITE_TOP_FRACTION = 0.2;
const AFFINITY_FAVOURITE = 1;
const AFFINITY_OTHER = 0.6;

export const SUPPORT_PROMPT_THRESHOLD = 0.55;

/**
 * World traction floor. A card with no audience must never trigger the prompt,
 * however deeply one player happens to play it — asking players to back a card
 * nobody else has touched reads as begging, and it is also the cheap way to
 * keep freshly-registered sock-puppet cards out of the funnel. Interactions
 * are favourites plus reviews: the two explicit, per-player signals a world
 * accumulates (messageCount is per-message and lives on another scale).
 */
export const MIN_WORLD_DOWNLOADS = 100;
export const MIN_WORLD_INTERACTIONS = 20;

export function worldMeetsTractionFloor(
  downloadCount: number,
  favoriteCount: number,
  reviewCount: number
): boolean {
  return (
    sanitize(downloadCount) >= MIN_WORLD_DOWNLOADS &&
    sanitize(favoriteCount) + sanitize(reviewCount) >= MIN_WORLD_INTERACTIONS
  );
}

export interface SupportPromptInputs {
  /** Lease-tracked active seconds across every session this player has in the world. */
  playtimeSeconds: number;
  /** Player-authored messages in the world. */
  turnCount: number;
  /** Distinct calendar days the player has played the world. */
  dayCount: number;
  /** 1-based rank of this world in the player's own playtime ordering. */
  worldRank: number;
  /** How many worlds the player has any playtime in. */
  worldsPlayed: number;
}

export interface SupportPromptScore {
  /** Weighted geometric mean of the three axes, 0–1. */
  depth: number;
  /** 1 for a favourite world, 0.6 otherwise. */
  affinity: number;
  /** depth × affinity, 0–1. */
  score: number;
  /** Whether the absolute minimums are met. */
  meetsFloor: boolean;
  /** meetsFloor and score at or above the threshold. */
  eligible: boolean;
}

/** Non-finite and negative inputs collapse to 0 rather than poisoning the math. */
function sanitize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Saturating ratio in [0, 1]. */
function axis(value: number, target: number): number {
  return Math.min(1, sanitize(value) / target);
}

function isFavourite(worldRank: number, worldsPlayed: number): boolean {
  const rank = Math.max(1, Math.floor(sanitize(worldRank)) || 1);
  const played = Math.max(1, Math.floor(sanitize(worldsPlayed)) || 1);
  if (rank <= FAVOURITE_TOP_N) return true;
  return rank <= Math.ceil(played * FAVOURITE_TOP_FRACTION);
}

export function scoreSupportPrompt(inputs: SupportPromptInputs): SupportPromptScore {
  const minutes = sanitize(inputs.playtimeSeconds) / 60;
  const turns = sanitize(inputs.turnCount);

  const t = axis(minutes, TARGET_MINUTES);
  const m = axis(turns, TARGET_TURNS);
  const d = axis(inputs.dayCount, TARGET_DAYS);

  // Math.pow(0, positive) is 0, which is exactly the behaviour we want on a
  // dead axis — no special case needed.
  const depth = Math.pow(t, WEIGHT_TIME) * Math.pow(m, WEIGHT_TURNS) * Math.pow(d, WEIGHT_DAYS);
  const affinity = isFavourite(inputs.worldRank, inputs.worldsPlayed)
    ? AFFINITY_FAVOURITE
    : AFFINITY_OTHER;

  const score = Math.min(1, Math.max(0, depth * affinity));
  const meetsFloor = minutes >= FLOOR_MINUTES && turns >= FLOOR_TURNS;

  return {
    depth,
    affinity,
    score,
    meetsFloor,
    eligible: meetsFloor && score >= SUPPORT_PROMPT_THRESHOLD,
  };
}
