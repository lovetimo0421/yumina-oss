// Who may share a room on an adult (limitless) card: story rooms and rules
// rooms use the same test. Every participant must have a birth year on file,
// be 18+, have chosen an adult content level, and not be limited-content-only.
import { getAgeFromBirthYear } from "@yumina/shared";

const ADULT_CONTENT_LEVELS = new Set(["sensitive", "r18", "r18g"]);

export type AdultGateReason = "birth-year-required" | "adult-required" | "limited-content-only";

export type AdultGateUser = {
  birthYear: number | null | undefined;
  /** Either the level itself or the preferences object holding it. */
  contentLevel?: unknown;
  preferences?: unknown;
  limitedContentOnly?: boolean | null;
};

/** A card is adult when it is rated above Limited ('all') or flagged NSFW. */
export function isAdultWorld(world: { ageRating?: string | null; isNsfw?: boolean | null }): boolean {
  return (world.ageRating ?? "all") !== "all" || world.isNsfw === true;
}

/** Why this account may not sit in a room on an adult card, or null when it may. */
export function adultGateFailure(account: AdultGateUser): AdultGateReason | null {
  if (account.limitedContentOnly) return "limited-content-only";
  if (account.birthYear == null) return "birth-year-required";
  if (getAgeFromBirthYear(account.birthYear) < 18) return "adult-required";
  const level = account.contentLevel ?? (account.preferences as { contentLevel?: unknown } | null | undefined)?.contentLevel;
  // No level chosen means the safe default.
  if (typeof level !== "string" || !ADULT_CONTENT_LEVELS.has(level)) return "adult-required";
  return null;
}

export function canJoinAdultWorld(account: AdultGateUser): { ok: true } | { ok: false; reason: AdultGateReason } {
  const reason = adultGateFailure(account);
  return reason ? { ok: false, reason } : { ok: true };
}
