const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/** Return one complete visible character, never half of an emoji surrogate. */
export function getAvatarInitial(value: string | null | undefined, fallback = "?"): string {
  const text = value?.trim() ?? "";
  if (!text) return fallback;

  if (graphemeSegmenter) {
    for (const { segment } of graphemeSegmenter.segment(text)) {
      return segment.toLocaleUpperCase();
    }
  }

  return Array.from(text)[0]?.toLocaleUpperCase() ?? fallback;
}

/** Build the familiar one/two-character fallback used by profile avatars. */
export function getAvatarInitials(
  value: string | null | undefined,
  maxInitials = 2,
  fallback = "?",
): string {
  const words = value?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return fallback;

  const initials = words
    .slice(0, Math.max(1, maxInitials))
    .map((word) => getAvatarInitial(word, ""))
    .join("");
  return initials || fallback;
}
