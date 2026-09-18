export type WorldStatus = "draft" | "published" | "unpublished";
export type AgeRating = "all" | "r18";
export type WorldVisibility = "public" | "followers";
export type TargetAudience = "male" | "female" | "all";

// Collapse any adult rating to "r18". The canonical adult value is now
// "sensitive" (commit 60fc8321 / migration 0027); legacy rows/prefs may hold
// "r18" or "r18g". Anything that isn't an explicit adult marker is "all".
export function normalizeAgeRating(raw: unknown): AgeRating {
  return raw === "sensitive" || raw === "r18" || raw === "r18g" ? "r18" : "all";
}

// User-side filter: single audience preference.
//   "all"    → see everything (no exclusion)
//   "male"   → see male + all-audience (exclude female-only)
//   "female" → see female + all-audience (exclude male-only)
export type AudiencePreference = TargetAudience;

export const AUDIENCE_PREFERENCE_DEFAULT: AudiencePreference = "all";

// Accepts legacy array format (pre-simplification) and single-string values.
// Legacy arrays: ["male","all"] → "male", ["female","all"] → "female",
// ["male","female","all"] → "all". Unknown/missing → "all".
export function normalizeAudiencePreference(raw: unknown): AudiencePreference {
  if (raw === "male" || raw === "female" || raw === "all") return raw;
  if (Array.isArray(raw)) {
    const has = (v: string) => raw.includes(v);
    if (has("male") && has("female")) return "all";
    if (has("male")) return "male";
    if (has("female")) return "female";
  }
  return "all";
}

export const AUDIENCE_TAG_MALE = "男性向";
export const AUDIENCE_TAG_FEMALE = "女性向";

// The curated official tags: 7 content categories plus the two audience tags
// (男性向/女性向, kept in sync from targetAudience by syncAudienceTags).
// Stored value is the Chinese label (all world tags are stored in canonical
// Chinese; see normalizeTagsForStorage on the server). Everything outside
// this list is a free-form author tag: creators can attach anything at
// publish time, and the Discover filter only surfaces a non-official tag to
// a player once enough of their played cards carry it (see
// PLAYED_TAG_FILTER_THRESHOLD).
export const OFFICIAL_WORLD_TAGS = [
  "角色卡",
  "世界卡",
  "模拟器",
  "游戏",
  "同人",
  "原创",
  "历史",
  "名著",
  AUDIENCE_TAG_MALE,
  AUDIENCE_TAG_FEMALE,
] as const;

// A non-official tag joins a player's Discover filter once at least this many
// distinct cards they've actually played (non-ephemeral session with at least
// one user message) carry it.
export const PLAYED_TAG_FILTER_THRESHOLD = 5;

// Cap on how many earned dynamic tags the filter surfaces (highest played
// counts win) so heavy players don't get an unbounded chip row. Players can
// additionally add/hide tags themselves via preferences.filterTags.
export const MAX_DYNAMIC_FILTER_TAGS = 20;

// Hard cap on the number of tags a world may carry. The publish UI and the
// create/update Zod schemas both enforce this, but those only guard the HTTP
// routes — imports, seed scripts, remix/duplicate and raw inserts bypass them.
// clampWorldTags is the single chokepoint every write path funnels through so
// no path can persist more than this, and a DB CHECK constraint backstops it.
export const MAX_WORLD_TAGS = 50;

/**
 * Normalize a tag list for storage: trim, drop empties, de-dupe
 * (case-insensitively, keeping the first spelling seen) and cap at
 * MAX_WORLD_TAGS. The audience tag (男性向/女性向) gates audience filtering and
 * is mandatory, so it is always retained — when the list is over the cap,
 * non-audience tags are dropped from the tail first.
 */
export function clampWorldTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const audience: string[] = [];
  const rest: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (t === AUDIENCE_TAG_MALE || t === AUDIENCE_TAG_FEMALE) audience.push(t);
    else rest.push(t);
  }
  const room = Math.max(0, MAX_WORLD_TAGS - audience.length);
  return [...rest.slice(0, room), ...audience];
}

export function syncAudienceTags(tags: string[], audience: TargetAudience): string[] {
  const normalized = clampWorldTags(tags);
  // A card explicitly tagged for both audiences must remain discoverable
  // through either tag. An explicit single-audience switch below still wins.
  if (
    audience === "all" &&
    normalized.includes(AUDIENCE_TAG_MALE) &&
    normalized.includes(AUDIENCE_TAG_FEMALE)
  ) return normalized;

  const filtered = normalized.filter(t => t !== AUDIENCE_TAG_MALE && t !== AUDIENCE_TAG_FEMALE);
  if (audience === "male") filtered.push(AUDIENCE_TAG_MALE);
  else if (audience === "female") filtered.push(AUDIENCE_TAG_FEMALE);
  // Adding the mandatory audience tag to a full list must drop something —
  // clamp so the audience tag is never the one squeezed out.
  return clampWorldTags(filtered);
}

export interface World {
  id: string;
  creatorId: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  thumbnailUrl: string | null;
  isPublished: boolean;
  status: WorldStatus;
  isNsfw: boolean;
  allowEdit: boolean;
  // Independent of allowEdit (which governs forking). When false, non-creators
  // are forced onto official keys so the world's hidden lorebook can't leak via
  // a player's BYOK provider logs. Default true.
  allowCustomApi: boolean;
  allowReviews: boolean;
  allowSessionSharing: boolean;
  allowCommunityCitations: boolean;
  // null = follow age rating (legacy/auto); true/false = explicit creator choice.
  blurCover: boolean | null;
  ageRating: AgeRating;
  targetAudience: TargetAudience;
  visibility: WorldVisibility;
  downloadCount: number;
  tags: string[];
  sourceWorldId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorldInput {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface UpdateWorldInput {
  name?: string;
  description?: string;
  schema?: Record<string, unknown>;
  thumbnailUrl?: string | null;
  isPublished?: boolean;
  isNsfw?: boolean;
  allowEdit?: boolean;
  allowCustomApi?: boolean;
  allowReviews?: boolean;
  allowSessionSharing?: boolean;
  allowCommunityCitations?: boolean;
  blurCover?: boolean | null;
  ageRating?: AgeRating;
  targetAudience?: TargetAudience;
  visibility?: WorldVisibility;
}

// Content snapshot. List endpoint returns rows without the
// schema blob to keep the payload small; fetch one by id to get the schema.
export interface WorldVersion {
  id: string;
  worldId: string;
  createdBy: string;
  name: string;
  note: string | null;
  createdAt: Date;
  publishedAt?: Date | null;
  source?: "manual" | "publish" | "live" | "backup";
  isLive?: boolean;
  canMakeLive?: boolean;
}

export interface WorldVersionWithSchema extends WorldVersion {
  schema: Record<string, unknown>;
}

export const MAX_VERSIONS_PER_WORLD = 10;
export const MAX_AUTO_VERSIONS_PER_WORLD = 20;
export { MAX_VERSION_NAME as MAX_VERSION_NAME_LENGTH } from "../constants/limits.js";
export { MAX_VERSION_NOTE as MAX_VERSION_NOTE_LENGTH } from "../constants/limits.js";

// ─── Edit re-review (held material changes to a published world) ─────

/** The four material surfaces that gate an already-published world's edit. */
export type MaterialChangeReason = "entries" | "frontend" | "ageRating" | "cover";

/**
 * Lifecycle of a held edit to a published world:
 *   draft    — held back from live, not yet submitted for review
 *   pending  — submitted, awaiting an admin decision
 *   rejected — admin rejected; the creator can revise and resubmit
 */
export type PendingEditStatus = "draft" | "pending" | "rejected";

/**
 * Compact summary the server attaches to a world for its creator (and admins)
 * so the editor can render the "changes held for review" banner without pulling
 * the full proposed schema. Null/absent when the published world has no held edit.
 */
export interface WorldPendingEditSummary {
  status: PendingEditStatus;
  reasons: MaterialChangeReason[];
  submittedAt: string | null;
  rejectionReason: string | null;
  rejectionDetail: string | null;
  updatedAt: string;
}
