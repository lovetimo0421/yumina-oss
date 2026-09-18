// Pure language-routing helpers — deliberately free of the i18next runtime
// (which has browser-only side effects on import, e.g. the localStorage-backed
// detector), so they can be unit-tested in Node and reused without booting i18n.

// `zh-Hant` (Traditional Chinese) is its own UI locale but deliberately NOT its
// own Discover catalog: the server normalizes both `zh-Hant` and `zh` to `zh`,
// so Traditional and Simplified viewers share one card pool. Keeping it a script
// subtag (not `zh-TW`) makes that normalization automatic and lets browsers in
// Taiwan/HK/Macau auto-route here.
export const SUPPORTED_LANGUAGES = ["en", "zh", "zh-Hant", "es", "ja"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function clampLanguage(lang: string | null | undefined): SupportedLanguage {
  if (!lang) return "en";
  const lower = lang.toLowerCase();
  // Traditional Chinese: the Hant script subtag or the Traditional regions
  // (Taiwan / Hong Kong / Macau).
  if (
    lower.startsWith("zh-hant") ||
    lower.startsWith("zh-tw") ||
    lower.startsWith("zh-hk") ||
    lower.startsWith("zh-mo")
  ) {
    return "zh-Hant";
  }
  // Everything else under zh (bare `zh`, Hans, CN, SG, …) is Simplified.
  if (lower.startsWith("zh")) {
    return "zh";
  }
  const base = lower.split("-")[0];
  return SUPPORTED_LANGUAGES.includes(base as SupportedLanguage)
    ? (base as SupportedLanguage)
    : "en";
}

/**
 * The Discover/content language for a UI locale. Collapses the Traditional UI
 * locale (`zh-Hant`) onto the shared `zh` catalog — mirroring the server's
 * `normalizeHubLanguage` — so a Traditional creator's new card is tagged `zh`
 * and joins the shared Chinese pool. Use this when tagging CONTENT (a world's
 * language), not when choosing which UI strings to load.
 */
export function contentLanguage(lang: string | null | undefined): string {
  const clamped = clampLanguage(lang);
  return clamped === "zh-Hant" ? "zh" : clamped;
}
