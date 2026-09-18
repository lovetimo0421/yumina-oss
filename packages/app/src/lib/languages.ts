export interface LanguageVariant {
  id: string;
  name: string;
  language: string | null;
  variantLabel: string | null;
  thumbnailUrl: string | null;
  /** Whether this variant accepts forks. Surfaced by `/api/worlds/:id/language-variants`
   *  so the Edit/Fork picker can disable rows the author has locked down.
   *  Older clients may receive `undefined`; treat that as "unknown" → enabled. */
  allowEdit?: boolean | null;
  /** Author of this specific variant. Used by the picker to short-circuit
   *  when the viewer owns one of the variants (no need to fork — go to
   *  edit directly). */
  creatorId?: string | null;
}

export const LANGUAGE_OPTIONS = [
  { code: "en", label: "English", short: "EN" },
  { code: "zh", label: "\u4E2D\u6587", short: "\u4E2D" },
  { code: "ja", label: "\u65E5\u672C\u8A9E", short: "\u65E5" },
  { code: "ko", label: "\uD55C\uAD6D\uC5B4", short: "\uD55C" },
  { code: "es", label: "Espa\u00F1ol", short: "ES" },
  { code: "fr", label: "Fran\u00E7ais", short: "FR" },
  { code: "de", label: "Deutsch", short: "DE" },
  { code: "pt", label: "Portugu\u00EAs", short: "PT" },
  { code: "ru", label: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439", short: "RU" },
  { code: "ar", label: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629", short: "AR" },
] as const;

/** Full language name: "en" -> "English" */
export const LANGUAGE_LABELS: Record<string, string> = Object.fromEntries(
  LANGUAGE_OPTIONS.map((o) => [o.code, o.label]),
);

/** Short badge text: "en" -> "EN", "zh" -> "中" */
export const LANGUAGE_SHORT: Record<string, string> = Object.fromEntries(
  LANGUAGE_OPTIONS.map((o) => [o.code, o.short]),
);

/** Valid language codes set */
export const VALID_LANGUAGE_CODES = new Set(LANGUAGE_OPTIONS.map((o) => o.code));

interface VariantLike {
  id?: string;
  name?: string | null;
  language?: string | null;
  variantLabel?: string | null;
}

/** The language a variant is written in, as that language names itself.
 *  Use where the LANGUAGE is the point — download filenames, badges. */
export function variantLanguageLabel(v: VariantLike): string {
  if (v.variantLabel) return v.variantLabel;
  if (v.language) return LANGUAGE_LABELS[v.language] ?? v.language;
  return v.name ?? "";
}

/**
 * Row labels for a variant list, keyed by variant id.
 *
 * An author-written `variantLabel` is returned verbatim — its contents are
 * never inspected, so a variant the author chose to call "English" stays
 * "English".
 *
 * With no label the row falls back to the variant's own title, which the author
 * already wrote in that language when they built the variant. That needs no
 * translation step and never goes stale, because it reads the live title rather
 * than a copy of it.
 *
 * Some cards carry one title in every language — named after a character
 * ("Takagi and Chi"), or 桜色の季節, which ships the same title in Chinese and
 * Japanese. Those rows get their language appended rather than substituted:
 * replacing the title would leave a list where some rows name the card and
 * others name a language, which reads as two different kinds of thing.
 */
export function variantRowLabels(variants: VariantLike[]): Map<string, string> {
  const titleOf = (v: VariantLike) => (v.variantLabel?.trim() || v.name?.trim()) ?? "";
  const counts = new Map<string, number>();
  for (const v of variants) {
    const t = titleOf(v);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const v of variants) {
    const key = v.id ?? titleOf(v);
    const authored = v.variantLabel?.trim();
    if (authored) {
      out.set(key, authored);
      continue;
    }
    const title = v.name?.trim() ?? "";
    const language = v.language ? LANGUAGE_LABELS[v.language] ?? v.language : "";
    if (!title) {
      out.set(key, language);
      continue;
    }
    const shared = (counts.get(title) ?? 0) > 1;
    out.set(key, shared && language ? `${title}（${language}）` : title);
  }
  return out;
}
