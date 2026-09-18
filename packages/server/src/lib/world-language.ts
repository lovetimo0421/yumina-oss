/**
 * Language normalizers, kept in a leaf module with no DB/Redis imports so that
 * pure logic depending on them (and its tests) doesn't drag the connection pool
 * into the module graph. Re-exported from `recommendations.ts` — every existing
 * importer keeps working, and there is still exactly one implementation.
 */

export type HubLanguage = "en" | "zh" | "es" | "ja";

/** Clamp a viewer's `lang` query param down to a supported hub locale. */
export function normalizeHubLanguage(lang?: string | null): HubLanguage | null {
  const base = lang?.trim().toLowerCase().split(/[-_]/)[0];
  return base === "en" || base === "zh" || base === "es" || base === "ja" ? base : null;
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
  return includeOtherLanguages ? null : normalizeHubLanguage(lang);
}

/**
 * Normalize the value stored in `worlds.language` on write. Strips regional
 * suffixes (`zh-CN` → `zh`, `en-US` → `en`) and lowercases, while preserving
 * non-Hub languages the editor's picker exposes (`ko`, …) so a creator who
 * deliberately tags a Korean card keeps that intent. Distinct from
 * `normalizeHubLanguage`, which clamps Discover's `lang` query param down to
 * the supported hub locales (en/zh/es/ja).
 */
export function normalizeWorldLanguage(lang?: string | null): string | null {
  if (lang === undefined || lang === null) return null;
  const base = lang.trim().toLowerCase().split(/[-_]/)[0];
  return base || null;
}
