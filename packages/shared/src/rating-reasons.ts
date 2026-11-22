// Low star ratings must say what went wrong (community thread, 2026-10-26).
// Most reasons are self-explanatory once picked ("too little content"), so one
// tap is enough. A bug or "other" tells the creator nothing without details —
// a bare "Bug" is barely better than a bare 1★ — so those need a short
// explanation, which is published as a comment the creator can reply to.

export const LOW_RATING_MAX = 2;

/** Display order. Stored comma-joined in this order. */
export const LOW_RATING_REASONS = [
  "bug",
  "ai_quality",
  "character_off",
  "not_as_described",
  "too_thin",
  "boring",
  "translation",
  "too_costly",
  "other",
] as const;

export type LowRatingReason = (typeof LOW_RATING_REASONS)[number];

/** Reasons the creator cannot act on without the player's details. */
export const LOW_RATING_REASONS_NEEDING_DETAIL: readonly LowRatingReason[] = ["bug", "other"];

/** Explanation length in "latin units": a CJK/kana/hangul character counts 2. */
export const LOW_RATING_MIN_EXPLANATION = 20;

/** Seconds of recorded play (across language variants) before rating opens. */
export const RATING_MIN_PLAYTIME_SECONDS = 60;

export function isLowRating(rating: number): boolean {
  return rating >= 1 && rating <= LOW_RATING_MAX;
}

export function isLowRatingReason(value: unknown): value is LowRatingReason {
  return typeof value === "string" && (LOW_RATING_REASONS as readonly string[]).includes(value);
}

/** Valid, de-duplicated, in display order; anything unknown is dropped. */
export function normalizeLowRatingReasons(values: readonly unknown[]): LowRatingReason[] {
  return LOW_RATING_REASONS.filter((reason) => values.includes(reason));
}

/** Read a stored comma-joined reason list (null-safe). */
export function parseLowRatingReasons(stored: string | null | undefined): LowRatingReason[] {
  return stored ? normalizeLowRatingReasons(stored.split(",")) : [];
}

export function serializeLowRatingReasons(reasons: readonly LowRatingReason[]): string | null {
  const normalized = normalizeLowRatingReasons(reasons);
  return normalized.length ? normalized.join(",") : null;
}

export function lowRatingNeedsExplanation(reasons: readonly LowRatingReason[]): boolean {
  return reasons.some((reason) => LOW_RATING_REASONS_NEEDING_DETAIL.includes(reason));
}

const WIDE_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

/** "it crashes" and "卡死了" are both too short; ten Chinese characters or
 *  twenty latin characters say where and how. Whitespace runs count once. */
export function lowRatingExplanationLength(text: string): number {
  let length = 0;
  for (const ch of text.trim().replace(/\s+/g, " ")) length += WIDE_CHAR.test(ch) ? 2 : 1;
  return length;
}

export function isLowRatingExplanationLongEnough(text: string): boolean {
  return lowRatingExplanationLength(text) >= LOW_RATING_MIN_EXPLANATION;
}
