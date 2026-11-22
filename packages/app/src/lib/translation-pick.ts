/**
 * Helpers for picking the right cached translation based on the viewer's
 * locale. API responses carry per-language fields (e.g. translatedContent_zh,
 * translatedContent_en, ... translatedContent_ru) and the client decides which
 * to show.
 *
 * Korean, Indonesian and Russian translations exist for content posted since
 * those languages were added (plus the two weeks before). Older content has
 * none, so those readers fall back to the English translation, which is what
 * they saw before. zh-Hant readers read the zh translation, converted on the
 * page (see useTraditionalize).
 */

export type TranslatedLang = "en" | "zh" | "es" | "ja" | "ko" | "id" | "ru";

export function normalizeLang(language: string | null | undefined): TranslatedLang {
  if (!language) return "en";
  if (language.startsWith("zh")) return "zh";
  if (language.startsWith("es")) return "es";
  if (language.startsWith("ja")) return "ja";
  if (language.startsWith("ko")) return "ko";
  if (language.startsWith("id")) return "id";
  if (language.startsWith("ru")) return "ru";
  return "en";
}

/** Languages whose readers fall back to the English translation while theirs is missing. */
const FALLS_BACK_TO_ENGLISH: ReadonlySet<TranslatedLang> = new Set(["ko", "id", "ru"]);

type PerLang<Prefix extends string> = Partial<Record<`${Prefix}_${TranslatedLang}`, string | null>>;

function pick<Prefix extends string>(source: PerLang<Prefix>, prefix: Prefix, lang: TranslatedLang): string | null {
  const own = source[`${prefix}_${lang}`];
  if (own != null) return own;
  return FALLS_BACK_TO_ENGLISH.has(lang) ? source[`${prefix}_en`] ?? null : null;
}

export function pickTranslatedContent(source: PerLang<"translatedContent">, lang: TranslatedLang): string | null {
  return pick(source, "translatedContent", lang);
}

export function pickTranslatedTitle(source: PerLang<"translatedTitle">, lang: TranslatedLang): string | null {
  return pick(source, "translatedTitle", lang);
}

export function pickTranslatedIntroduction(source: PerLang<"translatedIntroduction">, lang: TranslatedLang): string | null {
  return pick(source, "translatedIntroduction", lang);
}
