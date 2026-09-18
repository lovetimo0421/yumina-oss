/**
 * Helpers for picking the right cached translation based on the viewer's
 * locale. API responses carry per-language fields (e.g. translatedContent_zh,
 * translatedContent_en, translatedContent_es, translatedContent_ja) and the
 * client decides which to show.
 */

export type TranslatedLang = "en" | "zh" | "es" | "ja";

export function normalizeLang(language: string | null | undefined): TranslatedLang {
  if (!language) return "en";
  if (language.startsWith("zh")) return "zh";
  if (language.startsWith("es")) return "es";
  if (language.startsWith("ja")) return "ja";
  return "en";
}

type ContentSource = {
  translatedContent_zh?: string | null;
  translatedContent_en?: string | null;
  translatedContent_es?: string | null;
  translatedContent_ja?: string | null;
};

type TitleSource = {
  translatedTitle_zh?: string | null;
  translatedTitle_en?: string | null;
  translatedTitle_es?: string | null;
  translatedTitle_ja?: string | null;
};

type IntroductionSource = {
  translatedIntroduction_zh?: string | null;
  translatedIntroduction_en?: string | null;
  translatedIntroduction_es?: string | null;
  translatedIntroduction_ja?: string | null;
};

export function pickTranslatedContent(source: ContentSource, lang: TranslatedLang): string | null {
  if (lang === "zh") return source.translatedContent_zh ?? null;
  if (lang === "es") return source.translatedContent_es ?? null;
  if (lang === "ja") return source.translatedContent_ja ?? null;
  return source.translatedContent_en ?? null;
}

export function pickTranslatedTitle(source: TitleSource, lang: TranslatedLang): string | null {
  if (lang === "zh") return source.translatedTitle_zh ?? null;
  if (lang === "es") return source.translatedTitle_es ?? null;
  if (lang === "ja") return source.translatedTitle_ja ?? null;
  return source.translatedTitle_en ?? null;
}

export function pickTranslatedIntroduction(source: IntroductionSource, lang: TranslatedLang): string | null {
  if (lang === "zh") return source.translatedIntroduction_zh ?? null;
  if (lang === "es") return source.translatedIntroduction_es ?? null;
  if (lang === "ja") return source.translatedIntroduction_ja ?? null;
  return source.translatedIntroduction_en ?? null;
}
