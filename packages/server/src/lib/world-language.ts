/**
 * Language normalizers, kept in a leaf module with no DB/Redis imports so that
 * pure logic depending on them (and its tests) doesn't drag the connection pool
 * into the module graph. Re-exported from `recommendations.ts` — every existing
 * importer keeps working, and there is still exactly one implementation.
 */

export type HubLanguage = "en" | "zh" | "es" | "ja" | "ko" | "id" | "ru";
/** Hubs with their own editorial lineups and community boards. */
export type EditorialLanguage = Exclude<HubLanguage, "ko" | "id" | "ru">;

/** Clamp a viewer's `lang` query param down to a supported hub locale. */
export function normalizeHubLanguage(lang?: string | null): HubLanguage | null {
  const base = lang?.trim().toLowerCase().split(/[-_]/)[0];
  return base === "en" || base === "zh" || base === "es" || base === "ja" || base === "ko" || base === "id" || base === "ru" ? base : null;
}

/**
 * Card languages a hub shows, most preferred first. Every hub, Korean included
 * (306 Korean versions since 2026-11-19), shows its own language only; the
 * "other languages" toggle widens it. Indonesian and Russian have almost no
 * cards of their own yet, so their viewers see cards in their language first
 * and English cards behind them (the app's UI fallback language).
 */
export function hubLanguageChain(lang: HubLanguage): HubLanguage[] {
  return lang === "id" || lang === "ru" ? [lang, "en"] : [lang];
}

/**
 * Like normalizeHubLanguage, for surfaces that only exist for en/zh/es/ja:
 * editorial hero/featured lineups and community boards. Korean, Indonesian and
 * Russian viewers get the English ones, which is what they saw while their UI fell
 * back to English.
 */
export function normalizeEditorialLanguage(lang?: string | null): EditorialLanguage | null {
  const hub = normalizeHubLanguage(lang);
  return hub === "ko" || hub === "id" || hub === "ru" ? "en" : hub;
}

/**
 * Resolve the language scope for Discover. The default keeps the feed in the
 * viewer's UI language; the explicit opt-in removes that scope so cards remain
 * in, and can be discovered through, their own source language.
 */
export function resolveHubLanguageScope(
  lang?: string | null,
  includeOtherLanguages = false,
): HubLanguage | null {
  if (includeOtherLanguages) return null;
  // A viewer on an unsupported locale (e.g. "fr") gets the English
  // feed, which is what the app falls back to; only the explicit "all
  // languages" button widens the pool (owner, 2026-10-15). No lang at all
  // (creator pages, API clients) keeps the unscoped catalog.
  if (!lang?.trim()) return null;
  return normalizeHubLanguage(lang) ?? "en";
}

/**
 * Variant languages for an editorial pick, most preferred first. A Korean (or
 * Indonesian) viewer gets the English lineup, but sees a card's Korean
 * (Indonesian) version where it has one.
 */
export function variantLanguages(lang: string | null | undefined, editorial: EditorialLanguage): string[] {
  const hub = normalizeHubLanguage(lang);
  return hub && hub !== editorial ? [hub, editorial] : [editorial];
}

/**
 * Normalize the value stored in `worlds.language` on write. Strips regional
 * suffixes (`zh-CN` → `zh`, `en-US` → `en`) and lowercases, while preserving
 * non-Hub languages the editor's picker exposes (`ko`, …) so a creator who
 * deliberately tags a Korean card keeps that intent. Distinct from
 * `normalizeHubLanguage`, which clamps Discover's `lang` query param down to
 * the supported hub locales (en/zh/es/ja/ko/id/ru).
 */
export function normalizeWorldLanguage(lang?: string | null): string | null {
  if (lang === undefined || lang === null) return null;
  const base = lang.trim().toLowerCase().split(/[-_]/)[0];
  return base || null;
}
