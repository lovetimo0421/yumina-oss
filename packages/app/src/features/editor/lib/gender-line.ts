/* ─── Gender line (simple editor) ───
 *
 * The simple editor's gender picker stores its selection as a plain
 * "<Label>: <Value>" line as the FIRST line of the character entry's content
 * so the AI actually sees it — the PromptBuilder doesn't render tags into the
 * prompt.
 *
 * The picker only ever reads and mutates that first line. That is a safety
 * invariant, not a convenience: the multi-locale regex below would happily
 * match a creator's hand-written "Gender: Female" statblock line mid-content,
 * and a picker that adopts (and deletes on toggle-off) prose it didn't write
 * silently destroys authored content. First-line-only keeps every mutation
 * confined to the one line this feature owns.
 *
 * The line is written in the CARD's language (then sniffed from the content
 * for legacy rows with no language column, then the editor UI locale) so an
 * English card never carries a Chinese "性别：女" line. The serialization
 * table lives here in code — NOT in the i18n resource files — because this is
 * a content storage format that must stay parseable forever, while UI copy is
 * free to be reworded.
 *
 * Parsing accepts every variant this feature has ever written (the original
 * implementation always wrote Chinese), so legacy cards keep round-tripping.
 */

import { clampLanguage } from "../../../lib/language-clamp";

export type GenderValue = "female" | "male" | "other";

export const GENDER_VALUES: readonly GenderValue[] = ["female", "male", "other"];

interface GenderLocale {
  label: string;
  values: Record<GenderValue, string>;
  /** Latin locales read better with an ASCII colon + space. */
  asciiColon?: boolean;
}

const GENDER_LOCALES: Record<string, GenderLocale> = {
  zh: { label: "性别", values: { female: "女", male: "男", other: "其他" } },
  "zh-Hant": { label: "性別", values: { female: "女", male: "男", other: "其他" } },
  ja: { label: "性別", values: { female: "女性", male: "男性", other: "その他" } },
  en: { label: "Gender", values: { female: "Female", male: "Male", other: "Other" }, asciiColon: true },
  es: { label: "Género", values: { female: "Mujer", male: "Hombre", other: "Otro" }, asciiColon: true },
};

// Map every value word (across locales) back to the canonical enum. Longer
// words first in the regex alternation below so 女性 matches before 女.
const VALUE_TO_GENDER: Record<string, GenderValue> = {};
for (const { values } of Object.values(GENDER_LOCALES)) {
  for (const g of GENDER_VALUES) {
    VALUE_TO_GENDER[values[g].toLowerCase()] = g;
  }
}

const LABELS = [...new Set(Object.values(GENDER_LOCALES).map((l) => l.label))];
const VALUE_WORDS = [...new Set(Object.values(GENDER_LOCALES).flatMap((l) => Object.values(l.values)))]
  // longest-first so 女性/その他 win over their prefixes in alternation
  .sort((a, b) => b.length - a.length);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches a gender line this feature has ever written, in any locale. Only
 * `[ \t]` (never `\s`) around the value, so a "Gender:" label with the value
 * on the NEXT line — creator-formatted stat blocks do this — can never match.
 * No `m` flag: callers test one extracted line, not whole content.
 */
export const GENDER_LINE_RE = new RegExp(
  `^(?:${LABELS.map(escape).join("|")})[：:][ \\t]*(${VALUE_WORDS.map(escape).join("|")})[ \\t]*$`,
  "i",
);

/** The first line of the content (sans trailing \r for CRLF content). */
function firstLine(content: string): string {
  const nl = content.indexOf("\n");
  const line = nl === -1 ? content : content.slice(0, nl);
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Everything after the first line (and the newline that ends it). */
function restAfterFirstLine(content: string): string {
  const nl = content.indexOf("\n");
  return nl === -1 ? "" : content.slice(nl + 1);
}

/**
 * Sniff a content language for legacy rows whose worlds.language is null.
 * Those cards predate the language column and are overwhelmingly Chinese, so
 * CJK Han → zh (kana first → ja). Returns null when the content gives no
 * signal — the caller falls back to the UI locale.
 */
export function detectContentLocale(content: string | undefined): "zh" | "ja" | null {
  if (!content) return null;
  if (/[぀-ヿ]/.test(content)) return "ja"; // hiragana/katakana
  if (/[一-鿿]/.test(content)) return "zh";
  return null;
}

/**
 * Resolve which locale to serialize with. Card language wins (the line lives
 * in the card's content), then the editor UI locale, then English — every
 * major LLM reads English, so it is the safest universal fallback.
 * Normalization is clampLanguage's (zh-TW/HK/MO → zh-Hant, zh-* → zh,
 * region-tagged Latin codes → base), so this can't drift from the app's
 * language routing.
 */
export function resolveGenderLocale(cardLanguage: string | null | undefined, uiLanguage?: string): GenderLocale {
  for (const raw of [cardLanguage, uiLanguage]) {
    if (!raw) continue;
    return GENDER_LOCALES[clampLanguage(raw)]!;
  }
  return GENDER_LOCALES.en!;
}

export function getGenderFromContent(content: string | undefined): GenderValue | null {
  if (!content) return null;
  const match = firstLine(content).match(GENDER_LINE_RE);
  if (!match) return null;
  return VALUE_TO_GENDER[match[1]!.toLowerCase()] ?? null;
}

function serializeLine(gender: GenderValue, cardLanguage?: string | null, uiLanguage?: string, content?: string): string {
  const locale = resolveGenderLocale(cardLanguage || detectContentLocale(content), uiLanguage);
  return locale.asciiColon
    ? `${locale.label}: ${locale.values[gender]}`
    : `${locale.label}：${locale.values[gender]}`;
}

/**
 * Set, replace, or (gender === null) remove the gender line. Only the FIRST
 * line of the content is ever touched (see the header comment); anything the
 * creator wrote below it — including lines that happen to look like gender
 * lines — is returned byte-for-byte.
 */
export function setGenderInContent(
  content: string,
  gender: GenderValue | null,
  cardLanguage?: string | null,
  uiLanguage?: string,
): string {
  const base = content ?? "";
  const hasLine = GENDER_LINE_RE.test(firstLine(base));
  if (gender === null) {
    if (!hasLine) return base;
    return restAfterFirstLine(base).replace(/^\n+/, "");
  }
  const line = serializeLine(gender, cardLanguage, uiLanguage, base);
  if (hasLine) {
    const rest = restAfterFirstLine(base);
    return rest ? `${line}\n${rest}` : line;
  }
  return base ? `${line}\n${base}` : line;
}
