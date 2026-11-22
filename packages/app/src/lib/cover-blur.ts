/**
 * Whether a card's cover thumbnail should be blurred — the creator-controlled
 * decision, before the viewer's own "blur Limitless content" preference is
 * applied. Callers combine it as `blurSensitivePref && coverShouldBlur(world)`.
 *
 * `blurCover` is the creator's explicit choice and wins when set. `null` means
 * "follow age rating" (legacy/auto), so it falls back to the old derivation
 * (sensitive ⇒ blur) — this keeps existing cards behaving exactly as before
 * without a data migration.
 *
 * A Limited card never blurs, whatever `blurCover` says: a cover that needs
 * hiding means the card belongs in Limitless (Jason, 11/09). The publish
 * form, the admin sheet and the AI review all move such a card there rather
 * than blur it, so this only catches rows stored before that rule.
 */
export function coverShouldBlur(world: {
  blurCover?: boolean | null;
  ageRating?: string | null;
  isNsfw?: boolean | null;
}): boolean {
  const limited = world.ageRating ? world.ageRating === "all" : !world.isNsfw;
  if (limited) return false;
  return typeof world.blurCover === "boolean" ? world.blurCover : true;
}
