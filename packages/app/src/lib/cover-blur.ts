/**
 * Whether a card's cover thumbnail should be blurred — the creator-controlled
 * decision, before the viewer's own "blur Limitless content" preference is
 * applied. Callers combine it as `blurSensitivePref && coverShouldBlur(world)`.
 *
 * `blurCover` is the creator's explicit choice and wins when set. `null` means
 * "follow age rating" (legacy/auto), so it falls back to the old derivation
 * (sensitive ⇒ blur) — this keeps existing cards behaving exactly as before
 * without a data migration.
 */
export function coverShouldBlur(world: {
  blurCover?: boolean | null;
  ageRating?: string | null;
  isNsfw?: boolean | null;
}): boolean {
  if (typeof world.blurCover === "boolean") return world.blurCover;
  return world.ageRating ? world.ageRating !== "all" : !!world.isNsfw;
}
