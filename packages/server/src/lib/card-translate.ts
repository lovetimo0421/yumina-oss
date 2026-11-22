/**
 * Translate a whole card (world row text + schema) into another language.
 *
 * Built from the 2026-11-17 pilot (10 English cards -> Chinese, card-factory/stage/i18n-pilot).
 * What must survive verbatim: variable ids, `[var: op value]` directives, `{{placeholders}}`,
 * state values the interface compares (flat / half / up), code. Everything a player or the
 * narrator reads is translated. Each piece is checked and re-translated once if it fails;
 * whatever still fails is reported, never silently shipped.
 *
 * Pilot findings encoded here:
 *  - the glossary pass sometimes returns broken terms ("维尔 Dominion?") -> filtered;
 *  - "Yumina" got transliterated (尤米娜) -> pinned;
 *  - fandom jargon ("dead dove") was translated literally -> mapped;
 *  - a model duplicated a closing paragraph with one word left in English -> duplicate + stray-word checks;
 *  - English word counts were copied as Chinese character counts (replies got short) -> converted;
 *  - Chinese chats write fewer state directives (prod: zh 46% vs en 64% of replies) -> reminder appended.
 *
 * Russian batch (45 cards, 2026-11-21):
 *  - the interface string pass reused the prose rules, whose "keep state values, gloss them" rule produced labels
 *    like "flat (прижаты) back (назад)" and openings like "silver-green (серебристо-зелёный)" -> its own rules,
 *    the prose rule limited to instructions, glosses in player-facing text flagged and stripped;
 *  - a 167k-char interface with a STR string table was cut off whole and then in its one-call string pass
 *    (and isTruncation held backspace bytes instead of \b, so nothing split) -> string pass in split batches,
 *    no whole-file rewrite past WHOLE_FILE_MAX, string tables recognised (card-translate-tsx.ts).
 *  - DanMachi: 31 CSS class modifiers in ternaries (" here" -> " здесь") were translated -> class-name contexts
 *    recognised; 609 entries' keywords in one call failed -> batches, then filtered (card-translate-keywords.ts);
 *    pin notes listed ordinary words ("off, floor, next") -> only values a rule writes as values.
 */
import { applyDisplayStrings, checkTsxRewrite, comparedValues, extractDisplayStrings, hasVisibleProse, retargetLang, type DisplayString } from "./card-translate-tsx.js";
import { lostValues, valueNote } from "./card-translate-literals.js";
import { cleanKeywords, keywordPrompt } from "./card-translate-keywords.js";
import { CardPatternRunner } from "./card-translate-regex/runner.js";

export const CARD_TRANSLATE_LANGS = ["en", "zh", "es", "ko", "id", "ru"] as const;
export type CardLang = (typeof CARD_TRANSLATE_LANGS)[number];

const LANG_NAME: Record<CardLang, string> = { en: "English", zh: "Simplified Chinese", es: "Spanish", ko: "Korean", id: "Indonesian", ru: "Russian" };
const PLAYER_YOU: Record<CardLang, string> = { en: "you", zh: "你", es: "tú", ko: "당신", id: "kamu", ru: "ты" };

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatResult { text: string; costUsd: number; model: string }
export type ChatFn = (messages: ChatMessage[], opts: { json?: boolean; maxTokens?: number }) => Promise<ChatResult>;

export interface CardTranslateInput {
  name: string;
  description: string;
  extendedDescription?: string | null;
  announcement?: string | null;
  schema: Record<string, any>;
  sourceLang: CardLang;
  targetLang: CardLang;
}

export interface CardTranslateReport {
  costUsd: number;
  calls: number;
  /** Problems that remained after the repair pass. The caller decides whether to block. */
  issues: string[];
  /** Things a human may want to look at; not errors. */
  warnings: string[];
  tsxTranslated: string[];
  tsxKeptOriginal: string[];
  /** Interface files translated string by string (display texts only) after whole-file rewrites kept touching logic. */
  tsxPartial: string[];
  repaired: number;
  /** Format markers the interface parses (【Bella】, <face>smile</face>, a ``` fence) put back after the model lost them. */
  markersRestored: number;
  /** Variables whose rules got a sentence telling the narrator to write the code-matched values untranslated. */
  valuesPinned: number;
  /** The same problems, sorted for the creator: what kind, which part of the card, which entry/variable. */
  problems: TranslateProblem[];
  unitsTotal: number;
  /** Texts that never came back (left in the source language); unitsRefused of them because the model refused. */
  unitsMissing: number;
  unitsRefused: number;
}

export interface TranslateProblem {
  kind: "missing" | "refused" | "untranslated" | "placeholders" | "duplicate" | "too_short" | "state_value" | "interface_kept";
  field: "title" | "description" | "opening" | "entry" | "variable" | "behavior" | "interface";
  /** Entry / variable / behavior name, or interface file name; "" for title, description and opening. */
  where: string;
  detail: string;
}

/** The chat function signals an answer cut off at max_tokens with "length" / "truncat" in its error. */
export const isTruncation = (message: string) => /\blength\b|truncat/i.test(message);

export function problemKind(detail: string): TranslateProblem["kind"] {
  if (detail.startsWith("placeholders")) return "placeholders";
  if (detail.startsWith("duplicated")) return "duplicate";
  if (detail.startsWith("too short")) return "too_short";
  if (detail.startsWith("state value") || detail.startsWith("format marker")) return "state_value";
  if (detail === "missing" || detail === "empty") return "missing";
  return "untranslated";
}

export interface CardTranslateOutput {
  name: string;
  description: string;
  extendedDescription: string | null;
  announcement: string | null;
  schema: Record<string, any>;
  report: CardTranslateReport;
}

export type TranslateProgress = (step: "glossary" | "text" | "keywords" | "interface" | "checks", done: number, total: number) => void;

// ---------------------------------------------------------------------------
// helpers

const BRAND = "Yumina";
/** Interface files longer than this skip the whole-file rewrite: the answer could not fit the output cap. */
const WHOLE_FILE_MAX = 60000;
/** Keyword lists per keyword call, and their size cap (JSON characters). */
const KEYWORD_BATCH = 40;
const KEYWORD_BATCH_CHARS = 4000;
/** Characters of interface text per string-pass call. */
const UI_BATCH_CHARS = 3000;
const JS_WORDS = new Set(["string", "number", "boolean", "object", "undefined", "function", "true", "false", "null", "json"]);
const isCjk = (s: string) => /[一-鿿]/.test(s);
const cjkCount = (s: string) => (s.match(/[一-鿿]/g) ?? []).length;
const hangulCount = (s: string) => (s.match(/[가-힣]/g) ?? []).length;
const isCyrillic = (s: string) => /[Ѐ-ӿ]/.test(s);
const cyrillicCount = (s: string) => (s.match(/[Ѐ-ӿ]/g) ?? []).length;
/** Chinese has no spaces and Korean glues particles onto words, so `\b` boundaries don't apply. */
const unspaced = (s: string) => /[一-鿿가-힣]/.test(s);
const ID_FIELD = /^(id|slug|key|type|kind|model|code|tag|[a-z]+_id|[a-z]+_slug|[a-z]+Id|[a-z]+Slug)$/;
/** Space-separated Latin-script languages: whole-word matching and word counts apply. */
const isLatinLang = (lang: CardLang) => lang === "en" || lang === "es" || lang === "id";
/** Space-separated languages whose length limits are in words (Russian too): word counts carry over. */
const countsWords = (lang: CardLang) => isLatinLang(lang) || lang === "ru";
/** Whether a string is written (at least partly) in a language's script. */
const inScript = (lang: CardLang, s: string) => lang === "zh" ? isCjk(s) : lang === "ko" ? /[가-힣]/.test(s) : lang === "ru" ? /[Ѐ-ӿ]{2,}/.test(s) : /[A-Za-zÀ-ÿ]{2,}/.test(s);
const nativeCount = (lang: CardLang, s: string) => lang === "zh" ? cjkCount(s) : lang === "ru" ? cyrillicCount(s) : hangulCount(s);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Where `w` stands as a word in a text. `\b` only knows ASCII, so a Cyrillic value gets Unicode edges. */
const valueRe = (w: string) => unspaced(w) ? new RegExp(escapeRe(w))
  : isCyrillic(w) ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, "u")
  : new RegExp(`\\b${escapeRe(w)}\\b`);

export function parseJsonObject(text: string): Record<string, unknown> {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}

/** Replace engine directives for known variables and fenced code with opaque tokens (order-free restore). */
export function protect(text: string, varIds: ReadonlySet<string>) {
  const spans: string[] = [];
  // A salt so a card that already contains "⟦K0⟧" cannot be mistaken for one of our tokens. Derived
  // from the text, not random: a resumed job must send the model the same prompts to replay its cache.
  const saltFor = (n: number) => { let h = 2166136261 ^ n; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return ((h >>> 0) % 1679616).toString(36).padStart(4, "0"); };
  let salt = saltFor(0);
  for (let n = 1; text.includes(salt); n++) salt = saltFor(n);
  const keep = (s: string) => `⟦K${spans.push(s) - 1}${salt}⟧`;
  // Fenced code stays as is. A fence holding a status template (the narrator copies its wording)
  // is prose: it gets translated, with its directives still protected below.
  let out = text.replace(/```[\s\S]*?```/g, (m) => (fenceLooksLikeCode(m) ? keep(m) : m));
  // Ids may hold hyphens (current-scene, wolf-state): without "-" in the class those directives went to the
  // model and came back as "[current-scene: set Purification Room(정화의 방)]" or "[soul-rings: 색상 순서 설정]".
  out = out.replace(/\[([a-zA-Z_][\w.-]*)\s*:[^\]\n]*\]/g, (m, id: string) => (varIds.has(id.split(".")[0]!) || id === "audio" ? keep(m) : m));
  return { text: out, spans, salt };
}

export function fenceLooksLikeCode(fence: string): boolean {
  const tag = fence.match(/^```([\w+-]*)/)?.[1]?.toLowerCase() ?? "";
  if (tag && !["text", "txt", "md", "markdown", "plain", "plaintext"].includes(tag)) return true;
  const body = fence.replace(/^```[\w+-]*/, "").replace(/```$/, "").replace(/\{\{[^}]+\}\}/g, "");
  return /[{};]|=>|<\/?[A-Za-z][\w-]*[ >/]|^\s*(?:const|let|var|function|import|return|if|for)\b/m.test(body);
}

export function restore(text: string, spans: string[], salt = ""): string | null {
  const seen = new Set<number>();
  const out = text.replace(new RegExp(`⟦K(\\d+)${salt}⟧`, "g"), (_, i: string) => { seen.add(Number(i)); return spans[Number(i)] ?? ""; });
  return seen.size === spans.length ? out : null;
}

const placeholderSet = (s: string) => [...new Set((s.match(/\{\{[^}]+\}\}/g) ?? []).map((x) => x.toLowerCase().replace(/\s+/g, "")))].sort().join("|");

/** Paragraphs that appear twice (ignoring Latin words, so "inevitable" vs 无可避免 still counts as a repeat). */
export function duplicatedParagraphs(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 30);
  const key = (p: string) => p.replace(/[A-Za-z]+/g, "").replace(/\s/g, "");
  const out: string[] = [];
  for (let i = 1; i < paras.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = key(paras[i]!), b = key(paras[j]!);
      if (a.length > 20 && (a === b || (a.length > 40 && a.includes(b.slice(0, 40)) && Math.abs(a.length - b.length) < 15))) out.push(paras[i]!.slice(0, 40));
    }
  }
  return out;
}

export function unitProblems(src: string, out: string, sourceLang: CardLang, targetLang: CardLang, keep: ReadonlySet<string>, playerFacing: boolean): string[] {
  const p: string[] = [];
  if (!out.trim()) return ["empty"];
  if (placeholderSet(src) !== placeholderSet(out)) p.push(`placeholders differ (${placeholderSet(src)} vs ${placeholderSet(out)})`);
  const dup = duplicatedParagraphs(out);
  if (dup.length && !duplicatedParagraphs(src).length) p.push(`duplicated paragraph: ${dup[0]}`);
  const bare = out.replace(/\{\{[^}]+\}\}|\[[^\]\n]*\]|`[^`]*`|https?:\S+/g, " ");
  if (!isLatinLang(targetLang)) {
    const run = bare.match(/(?:\b[A-Za-z']{2,}\b[ ,]+){7,}/g);
    if (run) p.push(`untranslated: ${run[0].slice(0, 60)}`);
    if (nativeCount(targetLang, out) < Math.min(4, src.length / 8) && src.length > 30) p.push(`little ${LANG_NAME[targetLang]} in output`);
    // Korean may gloss a name in hanja, but a Chinese source left mostly untranslated shows as hanzi.
    if (targetLang === "ko" && sourceLang === "zh" && cjkCount(out) > hangulCount(out) * 0.2) p.push(`untranslated Chinese: ${(bare.match(/[一-鿿]{2,}/g) ?? []).slice(0, 3).join(" ")}`);
    if (playerFacing) {
      const stray = (bare.match(/\b[a-z][a-z'-]{3,}\b/g) ?? []).filter((w) => !keep.has(w) && !JS_WORDS.has(w));
      if (stray.length) p.push(`stray English: ${[...new Set(stray)].slice(0, 4).join(", ")}`);
    }
  } else if (sourceLang === "zh") {
    const left = bare.match(/[一-鿿]{2,}/g)?.filter((w) => !keep.has(w));
    if (left?.length) p.push(`untranslated Chinese: ${left.slice(0, 3).join(" ")}`);
  } else if (sourceLang === "ko") {
    const left = bare.match(/[가-힣]{2,}/g)?.filter((w) => !keep.has(w));
    if (left?.length) p.push(`untranslated Korean: ${left.slice(0, 3).join(" ")}`);
  } else if (src.length > 60 && out.trim() === src.trim()) {
    p.push("output identical to source");
  }
  if (sourceLang === "ru" && targetLang !== "ru") {
    const left = bare.match(/[Ѐ-ӿ]{3,}/g)?.filter((w) => !keep.has(w));
    if (left?.length) p.push(`untranslated Russian: ${left.slice(0, 3).join(" ")}`);
  }
  // Minimum output/source length. Chinese is the densest script; Korean sits between it and Latin text.
  const ratio = targetLang === "zh" ? 0.15
    : sourceLang === "zh" ? 0.6
    : targetLang === "ko" ? 0.25
    : sourceLang === "ko" ? 0.6
    : 0.4;
  if (src.length > 200 && out.length < src.length * ratio) p.push(`too short (${out.length} vs ${src.length})`);
  return p;
}

const SCRIPT_RUN: Record<"latin" | "cjk" | "hangul" | "cyrillic", string> = {
  latin: String.raw`[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*(?:[ \t]+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*){0,3}`,
  cjk: String.raw`[一-鿿]{1,12}`,
  hangul: String.raw`[가-힣]+(?:[ \t]+[가-힣]+){0,3}`,
  cyrillic: String.raw`[Ѐ-ӿ][Ѐ-ӿ'-]*(?:[ \t]+[Ѐ-ӿ][Ѐ-ӿ'-]*){0,3}`,
};
const scriptOf = (lang: CardLang) => lang === "zh" ? "cjk" : lang === "ko" ? "hangul" : lang === "ru" ? "cyrillic" : "latin";

/**
 * Glosses the model left in a translation: a source-language word with its translation in parentheses,
 * "silver-green (серебристо-зелёный)", "flat (прижаты) back (назад)". Between two Latin-script languages a
 * gloss can't be told from a remark by its script, so there only a code value counts ("flat (plano)").
 */
export function glosses(src: string, out: string, sourceLang: CardLang, targetLang: CardLang, values: ReadonlySet<string> = new Set()): Array<{ text: string; word: string; meaning: string; index: number }> {
  const sameScript = scriptOf(sourceLang) === scriptOf(targetLang);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_{])(${SCRIPT_RUN[scriptOf(sourceLang)]})[ \\t]*[(（]([^()（）\\n]{1,60})[)）]`, "gu");
  const res: Array<{ text: string; word: string; meaning: string; index: number }> = [];
  const lower = new Set([...values].map((v) => v.toLowerCase()));
  for (const m of out.matchAll(re)) {
    let word = m[1]!.trim(); const meaning = m[2]!.trim();
    if (!inScript(targetLang, meaning)) continue;
    if (sameScript) {
      // Only the code value right before the bracket: "the ears stay flat (plano)" glosses "flat".
      const hit = [...lower].filter((v) => word.toLowerCase().endsWith(v)).sort((a, b) => b.length - a.length)[0];
      if (!hit || src.includes(meaning)) continue;
      word = word.slice(word.length - hit.length);
    }
    // The source wrote this bracket itself ("Seiran (her nickname)"): not a gloss.
    if (new RegExp(`${escapeRe(word)}[ \\t]*[(（]`).test(src)) continue;
    const at = m.index! + m[1]!.length - word.length;
    res.push({ text: out.slice(at, m.index! + m[0].length), word, meaning, index: at });
  }
  // The other way round: a translated word followed by the source word in brackets, "девушки (purple-haired)".
  if (!sameScript) {
    const back = new RegExp(`[ \\t]*[(（](${SCRIPT_RUN[scriptOf(sourceLang)]})[)）]`, "gu");
    for (const m of out.matchAll(back)) {
      const word = m[1]!;
      const prev = out.slice(0, m.index!).trimEnd().slice(-1);
      if (!prev || !inScript(targetLang, prev + prev) || !src.toLowerCase().includes(word.toLowerCase())) continue;
      if (new RegExp(`[(（]${escapeRe(word)}[)）]`, "i").test(src)) continue;
      res.push({ text: m[0], word, meaning: "", index: m.index! });
    }
  }
  return res;
}

/** Drop the source-language half of each gloss, keeping the translation (capitalised where the word was, or at a sentence start). */
export function stripGlosses(src: string, out: string, sourceLang: CardLang, targetLang: CardLang, values: ReadonlySet<string> = new Set()): string {
  let text = out;
  for (const g of glosses(src, out, sourceLang, targetLang, values).sort((a, b) => b.index - a.index)) {
    // At the very start the source decides ("flat back" is a lowercase label; "The purple-haired girl" a sentence).
    const before = text.slice(0, g.index);
    const startsSentence = /^\p{Lu}/u.test(g.word) || (/^[*_«"“—\s-]*$/.test(before) ? /^[^\p{L}]*\p{Lu}/u.test(src) : /(?:\n|[.!?…]["»”]?\s+)[*_«"“—-]*\s*$/.test(before));
    const meaning = startsSentence ? g.meaning.charAt(0).toLocaleUpperCase() + g.meaning.slice(1) : g.meaning;
    text = text.slice(0, g.index) + meaning + text.slice(g.index + g.text.length);
  }
  return text;
}

// ---------------------------------------------------------------------------
// prompts

/**
 * Rules for an interface's visible texts translated one by one (the fallback when a whole-file rewrite keeps
 * touching logic). Not the prose rules: their "keep state values" rule turned labels into
 * "flat (прижаты) back (назад)". Values the code compares are never sent here, so nothing has to be kept.
 */
export function uiRules(src: CardLang, tgt: CardLang, glossary: Record<string, string>): string {
  return `You translate the visible texts of a game's interface (labels, captions, button text, menu entries, short descriptions, table cells) from ${LANG_NAME[src]} into ${LANG_NAME[tgt]}. A player reads every one of them on screen.
Rules:
1. Translate each text plainly into natural, concise ${LANG_NAME[tgt]} interface language; short labels stay short.
2. Never leave a ${LANG_NAME[src]} word next to its translation and never add a translation or explanation in parentheses: "flat back" becomes only the ${LANG_NAME[tgt]} words for "flat back".
3. Keep every {placeholder}, {{placeholder}}, %s, emoji, markup, line break and leading/trailing space exactly. Keep an empty-looking text as it is.
4. Address the player as ${PLAYER_YOU[tgt]}. "${BRAND}" is the platform's name: never translate it.
5. Adult or dark content is translated faithfully. Add no notes.
6. Use this glossary for names and terms: ${JSON.stringify(glossary)}
Reply with a JSON object with exactly the same keys as the input, each value the translation.`;
}

export function proseRules(src: CardLang, tgt: CardLang, varIds: string[], stateValues: string[], glossary: Record<string, string>, markers: string[] = []): string {
  const style: Record<CardLang, string> = {
    zh: "Write natural Simplified Chinese the way a good Chinese web-novel / light-novel author would write it originally. No translationese. Dialogue in Chinese quotes “”.",
    en: "Write natural, idiomatic English fiction prose, as if originally written in English. No translationese. Dialogue in double quotes.",
    es: "Write natural, idiomatic Spanish (neutral, understandable across Spain and Latin America), as if originally written in Spanish. Use ¿? and ¡! correctly. Dialogue in double quotes or em-dash dialogue, consistently.",
    id: "Write natural, idiomatic Indonesian (Bahasa Indonesia) the way a good Indonesian web-novel author (Wattpad, NovelToon) would write it originally. No translationese, no stiff formal register unless the source is formal. In dialogue give each character the register that fits who they are speaking to (aku/kamu or gue/lo between friends and lovers, saya/Anda when formal), and keep it consistent. Dialogue in double quotes.",
    ru: "Write natural, idiomatic Russian the way a good Russian web-fiction author (Ficbook, Author.Today) would write it originally. No translationese: no calques, no bureaucratic words (данный, осуществлять), no chains of passives. Keep the register of each character's speech (ты between friends and lovers, вы when formal or distant) and keep it consistent. Keep dialogue in the same quote marks as the source (the card's interface may style quoted speech) rather than switching to dash dialogue.",
    ko: "Write natural Korean the way a good Korean web-novel author would write it originally. No translationese. Narration in the plain written style (해라체) unless the source voice is clearly conversational; in dialogue give each character the speech level (존댓말/반말) that fits who they are speaking to, and keep it consistent. Dialogue in double quotes “”.",
  };
  const counts = tgt === "zh" && countsWords(src) ? 'Convert word counts into Chinese character counts at about 1.6x (e.g. "150-400 words" -> 250-650字; "under 12 words" -> 20字以内).'
    : src === "zh" && countsWords(tgt) ? 'Convert Chinese character counts into word counts at about 0.6x (e.g. "300字" -> about 180 words).'
    : tgt === "ko" && countsWords(src) ? 'Convert word counts into Korean character counts (spaces included) at about 3x (e.g. "150-400 words" -> 450~1200자; "under 12 words" -> 35자 이내).'
    : src === "ko" && countsWords(tgt) ? 'Convert Korean character counts into word counts at about 0.33x (e.g. "600자" -> about 200 words).'
    : src === "zh" && tgt === "ko" ? 'Convert Chinese character counts into Korean character counts at about 1.3x (e.g. "300字" -> about 400자).'
    : src === "ko" && tgt === "zh" ? 'Convert Korean character counts into Chinese character counts at about 0.75x (e.g. "400자" -> about 300字).'
    : "Keep any length limits as they are.";
  const jargon = tgt === "zh"
    ? 'English fandom jargon uses the terms Chinese readers know: "dead dove (do not eat)" -> 重口预警, "slow burn" -> 慢热, "POV" -> 视角, "OOC" -> OOC.'
    : tgt === "ko"
      ? 'Fandom jargon uses the terms Korean readers know: "dead dove (do not eat)" -> 지뢰 주의, "slow burn" -> 슬로우번, "POV" -> 시점, "OOC" -> 캐붕, "fluff" -> 달달물, "angst" -> 앵스트.'
      : tgt === "id"
        ? 'Indonesian fandom readers use English fandom jargon as is: keep "slow burn", "POV", "OOC", "fluff", "angst", "enemies to lovers", "dead dove" in English.'
        : tgt === "ru"
          ? 'Fandom jargon uses the terms Russian readers (Ficbook) know: "slow burn" -> слоубёрн, "OOC" -> ООС, "AU" -> AU, "fluff" -> флафф, "angst" -> ангст, "enemies to lovers" -> от врагов к возлюбленным, "POV" -> POV, "dead dove (do not eat)" -> dead dove.'
          : "Keep fandom jargon in the form readers of the target language actually use.";
  return `You translate an interactive-fiction card on Yumina from ${LANG_NAME[src]} into ${LANG_NAME[tgt]}. Some text is read by players (titles, opening scenes, interface labels); the rest is instructions the narrator AI reads.

Rules:
1. ${style[tgt]} Keep *asterisk* action markup, markdown, line breaks and list structure exactly.
2. Keep verbatim: every {{placeholder}} (you may move it within the sentence); every token like ⟦K3⟧ (copy each exactly once); these variable ids: ${varIds.join(", ") || "(none)"}.
3. These are state values the game code checks: ${stateValues.join(", ") || "(none)"}. Only where the text tells the narrator which value to write or set (a variable's allowed values, an output format, a directive example) keep the value exactly as written; there you may add the ${LANG_NAME[tgt]} meaning in parentheses once. Everywhere else (narration, dialogue, opening scenes, descriptions, titles) the same word is ordinary language: translate it, with no ${LANG_NAME[src]} word left in and no translation in parentheses ("silver-green hair" is just the ${LANG_NAME[tgt]} for silver-green hair).
4. Any instruction about the output language ("Write in natural, idiomatic English") becomes an instruction to write in natural ${LANG_NAME[tgt]}. Style rules that only make sense in the source language (tense, contractions, spelling) are adapted or dropped.
5. ${counts}
6. "Player"/"you" used as the player's name becomes ${PLAYER_YOU[tgt]}. "${BRAND}" is the platform's name: never translate or transliterate it.
7. ${jargon}
8. Adult or dark content is translated faithfully, nothing softened or removed. Add no notes.
9. Use this glossary for names and terms, consistently: ${JSON.stringify(glossary)}
10. "meta.name" is the card's title on the store. Make it read like a natural, catchy title an author writing in ${LANG_NAME[tgt]} would give it, not a word-for-word gloss ("Size Class" is not 尺寸等级; "Open Fantasy" is not 开放奇幻). Keep character names as in the glossary.${markers.length ? `
11. The game's interface parses these format markers out of messages: ${markers.join("  ")}. Wherever one appears (in an opening scene, an example or an output format), copy the marker byte for byte, including its brackets, tag names, labels, ids inside tags and quote marks; translate only the words around it.` : ""}
Reply with a JSON object with exactly the same keys as the input, each value the translation.`;
}

// ---------------------------------------------------------------------------
// main

export async function translateCard(input: CardTranslateInput, chat: ChatFn, onProgress?: TranslateProgress): Promise<CardTranslateOutput> {
  // The card's own regexes run in a worker with a clock (card-translate-regex/runner.ts), never on this thread.
  const rx = new CardPatternRunner();
  try {
    const result = await translateWith(rx, input, chat, onProgress);
    result.report.warnings.push(...rx.notes);
    return result;
  } finally {
    rx.close();
  }
}

async function translateWith(rx: CardPatternRunner, input: CardTranslateInput, chat: ChatFn, onProgress?: TranslateProgress): Promise<CardTranslateOutput> {
  const { sourceLang: src, targetLang: tgt } = input;
  if (src === tgt) throw new Error("source and target language are the same");
  const S = input.schema;
  const report: CardTranslateReport = { costUsd: 0, calls: 0, issues: [], warnings: [], tsxTranslated: [], tsxKeptOriginal: [], tsxPartial: [], repaired: 0, markersRestored: 0, valuesPinned: 0, problems: [], unitsTotal: 0, unitsMissing: 0, unitsRefused: 0 };
  const call: ChatFn = async (m, o) => { const r = await chat(m, o); report.costUsd += r.costUsd; report.calls++; return r; };

  const entries: any[] = Array.isArray(S.entries) ? S.entries : [];
  const variables: any[] = Array.isArray(S.variables) ? S.variables : [];
  const rules: any[] = Array.isArray(S.rules) ? S.rules : [];
  const settings: Record<string, any> = S.settings && typeof S.settings === "object" ? S.settings : {};
  const files: Array<[string, string]> = Object.entries(S.rootComponent?.files ?? {}).map(([k, v]: [string, any]) => [k, typeof v === "string" ? v : v?.content ?? ""]);
  const varIds = variables.map((v) => String(v.id));
  const varIdSet = new Set(varIds);

  // State values: anything the interface compares, plus string values rules/conditions test against.
  const logic = new Set<string>();
  for (const [, code] of files) for (const v of comparedValues(code)) logic.add(v);
  const walk = (o: any) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { if (typeof o.value === "string" && o.value.length < 40) logic.add(o.value); Object.values(o).forEach(walk); } };
  walk(rules); walk(entries.map((e) => e.conditions));
  // Everything else the code matches literally: lookup-map keys, substring scans, options, JSON keys,
  // and the formats its interface parses (see card-translate-literals.ts).
  const lit = await rx.literals(S);
  for (const v of [...lit.values, ...lit.keys]) if (v.length <= 40) logic.add(v);
  // Values a variable lists that a code regex reads: kept in prose like the rest, but not interface logic.
  const codeMatched = [...lit.values, ...lit.keys, ...lit.listed];
  const state = new Set<string>([...logic, ...[...lit.listed].filter((v) => v.length <= 40)]);
  const proseBlob = [...entries.map((e) => e.content ?? ""), ...variables.map((v) => `${v.description ?? ""} ${v.behaviorRules ?? ""}`)].join("\n");
  // A one-letter value ("A" for a grade) would match every English article; such values are left to the TSX check.
  const stateValues = [...state].filter((w) => /[A-Za-z一-鿿가-힣Ѐ-ӿ]/.test(w) && (unspaced(w) || w.length >= 2) && !JS_WORDS.has(w) && valueRe(w).test(proseBlob)).slice(0, 200);

  // 1. Glossary
  onProgress?.("glossary", 0, 1);
  let glossary: Record<string, string> = {};
  try {
    const r = await call([
      { role: "system", content: "You build a translation glossary. Reply with JSON only." },
      { role: "user", content: `List every proper noun in this ${LANG_NAME[src]} roleplay card (people, places, groups, items, invented terms) and give the ${LANG_NAME[tgt]} form a professional translator of web fiction would use, consistently. Return {"terms":{"source":"target"}}.\n\nTITLE: ${input.name}\nDESCRIPTION: ${input.description}\n${entries.map((e) => `## ${e.name}\n${e.content ?? ""}`).join("\n\n").slice(0, 24000)}` },
    ], { json: true, maxTokens: 16000 });
    glossary = (parseJsonObject(r.text).terms as Record<string, string>) ?? {};
  } catch { report.warnings.push("glossary step failed; names may be inconsistent"); }
  for (const [k, v] of Object.entries(glossary)) {
    const clean = typeof v === "string" ? v.replace(/\{\{[^}]+\}\}/g, "") : "";
    const broken = typeof v !== "string" || /[?？]/.test(v) || (!isLatinLang(tgt) && /[A-Za-z]{3,}/.test(clean.replace(/APP|PTSD|NSFW|OOC|AI/g, ""))) || (tgt !== "zh" && isCjk(clean)) || (tgt !== "ko" && /[가-힣]/.test(clean)) || (tgt !== "ru" && isCyrillic(clean));
    if (broken) delete glossary[k];
  }
  // A variable id or a JSON field name is code, not a term: Indonesian DanMachi's glossary held "title": "judul" and
  // "gear": "perlengkapan", and the rules then told the narrator to write falna.judul / falna.perlengkapan.
  const fieldNames = new Set<string>(varIds.map((x) => x.toLowerCase()));
  const addKeys = (v: unknown, depth = 0): void => { if (!v || typeof v !== "object" || depth > 3) return; for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) fieldNames.add(k.toLowerCase()); addKeys(x, depth + 1); } };
  for (const v of variables) if (v.type === "json") addKeys(v.defaultValue);
  for (const k of Object.keys(glossary)) if (/^[a-z_][\w-]*$/.test(k.trim()) && fieldNames.has(k.trim().toLowerCase())) delete glossary[k];
  glossary[BRAND] = BRAND;
  onProgress?.("glossary", 1, 1);

  // 2. Prose units
  const units: Record<string, string> = {};
  const playerFacing = new Set<string>();
  const put = (k: string, v: unknown, facing = false) => {
    if (typeof v !== "string" || !v.trim()) return;
    if (!inScript(src, v)) return;
    units[k] = v; if (facing) playerFacing.add(k);
  };
  put("meta.name", input.name, true); put("meta.description", input.description, true);
  put("meta.extended_description", input.extendedDescription, true); put("meta.announcement", input.announcement, true);
  entries.forEach((e, i) => { put(`entry.${i}.name`, e.name); put(`entry.${i}.content`, e.content, e.role === "greeting"); });
  variables.forEach((v, i) => { put(`var.${i}.name`, v.name, true); put(`var.${i}.description`, v.description); put(`var.${i}.behaviorRules`, v.behaviorRules); });
  // Default values the interface shows ("out, back in an hour", a list of house rules). Values the
  // rules or the interface compare against are state values and stay as they are.
  // A sentence (3+ words), or a 2-word list item ("Brother (executed)"). Two-word fields are often
  // enum-like states ("Safe House") the rules keep in the source language, so they stay.
  // Words must be separated by whitespace: "google/gemini-3-flash", "baek-seo-rin" and
  // "Bathroom=Empty;Kitchen=Empty" are identifiers, not sentences.
  const proseValue = (x: unknown, inList = false): x is string => typeof x === "string" && !state.has(x.trim())
    && (unspaced(x) || /\s/.test(x.trim()))
    && !/^(?:@asset:|https?:|data:|\/|\[|\{)/.test(x.trim()) && (unspaced(x)
    ? x.trim().length >= 4
    : (inList ? /[A-Za-zÀ-ÿЀ-ӿ]{2,}(?:[^A-Za-zÀ-ÿЀ-ӿ]+[A-Za-zÀ-ÿЀ-ӿ]{2,})+/ : /[A-Za-zÀ-ÿЀ-ӿ]{2,}(?:[^A-Za-zÀ-ÿЀ-ӿ]+[A-Za-zÀ-ÿЀ-ӿ]{2,}){2,}/).test(x));
  const defaultLeaves: Array<{ key: string; i: number; path: Array<string | number> }> = [];
  const walkDefault = (i: number, node: unknown, path: Array<string | number>) => {
    // Identifier fields (slugs, ids, model names) are data even when they look like words.
    const field = [...path].reverse().find((x) => typeof x === "string");
    if (typeof field === "string" && ID_FIELD.test(field)) return;
    if (proseValue(node, typeof path[path.length - 1] === "number")) { const key = `var.${i}.default${path.length ? "." + path.join(".") : ""}`; put(key, node, true); if (key in units) defaultLeaves.push({ key, i, path }); }
    else if (Array.isArray(node)) node.forEach((x, j) => walkDefault(i, x, [...path, j]));
    else if (node && typeof node === "object") for (const [k, x] of Object.entries(node)) walkDefault(i, x, [...path, k]);
  };
  variables.forEach((v, i) => { if (v.type === "string" || v.type === "json") walkDefault(i, v.defaultValue, []); });
  rules.forEach((r, i) => { put(`rule.${i}.name`, r.name); put(`rule.${i}.description`, r.description); (r.actions ?? []).forEach((a: any, j: number) => put(`rule.${i}.action.${j}.message`, a.message, true)); });
  const greetIdx = entries.findIndex((e) => e.role === "greeting");
  const greetingIsEntry = greetIdx >= 0 && entries[greetIdx].content === settings.greeting;
  if (!greetingIsEntry) put("settings.greeting", settings.greeting, true);
  put("settings.systemPrompt", settings.systemPrompt);

  const protectedUnits: Record<string, { text: string; spans: string[]; salt: string }> = {};
  for (const [k, v] of Object.entries(units)) protectedUnits[k] = protect(v, varIdSet);
  const keys = Object.keys(units);
  // The markers as they appear in this card (【Bella】, <face>smile</face>, [Status Panel]), so the model
  // sees the exact strings to copy rather than a regex.
  const markerTexts = Object.entries(units).filter(([k]) => /^(entry\.\d+\.content|settings\.(greeting|systemPrompt))$/.test(k)).map(([k, text]) => ({ text, facing: playerFacing.has(k) }));
  const markers = new Set<string>(await rx.markers(markerTexts, lit.patterns));
  if (lit.patterns.some((p) => p.multiline && /`{3}/.test(p.src))) markers.add("```");
  const rulesText = proseRules(src, tgt, varIds, stateValues, glossary, [...markers]);
  const keepWords = new Set<string>([...stateValues, ...varIds, ...Object.values(glossary), BRAND]);
  const out: Record<string, string> = {};

  // Chinese -> English/Spanish output runs ~2.5x the source length (plus the model's hidden reasoning), so
  // Chinese sources go in smaller batches; 5000 Chinese chars per call hit the output cap (zh->en run, 2026-11-18).
  const batchChars = countsWords(src) ? 5000 : 2000;
  const batches: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {}, size = 0;
  for (const k of keys) {
    const t = protectedUnits[k]!.text;
    if (size + t.length > batchChars && Object.keys(cur).length) { batches.push(cur); cur = {}; size = 0; }
    cur[k] = t; size += t.length;
  }
  if (Object.keys(cur).length) batches.push(cur);

  const accept = (k: string, translated: string) => {
    const restored = restore(translated, protectedUnits[k]!.spans, protectedUnits[k]!.salt);
    if (restored != null) out[k] = restored;
  };
  let done = 0;
  /** Why a unit never came back: the model refused it, or the call failed (timeout, provider error, bad JSON). */
  const failedWith: Record<string, "refused" | "error"> = {};
  // A batch whose answer is cut off at the output cap is split in half and retried, never resent as is.
  const runBatch = async (b: Record<string, string>): Promise<void> => {
    for (let t = 0; t < 3; t++) {
      try {
        const r = parseJsonObject((await call([{ role: "system", content: rulesText }, { role: "user", content: JSON.stringify(b, null, 1) }], { json: true, maxTokens: 32000 })).text);
        const missing = Object.keys(b).filter((k) => typeof r[k] !== "string" || !(r[k] as string).trim());
        for (const k of Object.keys(b)) if (typeof r[k] === "string") accept(k, r[k] as string);
        if (!missing.length) return;
      } catch (e) {
        const msg = String((e as Error).message);
        const keysLeft = Object.keys(b).filter((k) => !(k in out));
        if (isTruncation(msg) && keysLeft.length > 1) {
          const half = Math.ceil(keysLeft.length / 2);
          await runBatch(Object.fromEntries(keysLeft.slice(0, half).map((k) => [k, b[k]!])));
          await runBatch(Object.fromEntries(keysLeft.slice(half).map((k) => [k, b[k]!])));
          return;
        }
        for (const k of keysLeft) failedWith[k] = /refus/i.test(msg) ? "refused" : "error";
        if (isTruncation(msg)) return; // one text too long for any retry to fit: reported as missing
      }
    }
  };
  await pool(batches, 4, async (b) => {
    await runBatch(b);
    done++; onProgress?.("text", done, batches.length);
  });

  // Repair pass: re-translate each failing unit alone, naming the problem.
  // The values a variable rule must keep as written: ones it writes as values (listed, quoted, ids, assigned to a
  // variable), not every code-scanned word it happens to use ("off, floor, next, where" were pinned on DanMachi's
  // Russian rules, which pushes English into the story). A number or boolean variable has no text values of its
  // own, so there only a value it gives another variable counts.
  const pinnable = (k: string, text: string) => {
    const v = variables[Number(k.split(".")[1])];
    return lostValues(units[k]!, text, [...codeMatched, ...stateValues], { ids: varIds, onlyAssigned: v?.type === "number" || v?.type === "boolean" });
  };
  const isText = (k: string) => /^(entry\.\d+\.content|settings\.(greeting|systemPrompt))$/.test(k);
  const isVarRule = (k: string) => /^var\..*(behaviorRules|description)$/.test(k);
  // Variable rules are where state values are defined: a value translated there means the
  // narrator will write a value the interface does not recognise (zh->en run: 苍浪大学 -> "Canglang University").
  // Openings and format instructions are where the interface's markers live: a marker translated there
  // means the renderer no longer finds the speaker tag / status panel / portrait id.
  const problemsIn = async (k: string, text: string) => {
    const p = unitProblems(units[k]!, text, src, tgt, keepWords, playerFacing.has(k));
    // What a player reads never carries "silver-green (серебристо-зелёный)": a gloss belongs, at most, in the
    // narrator's instructions about which value to write.
    if (playerFacing.has(k)) for (const g of glosses(units[k]!, text, src, tgt, state).slice(0, 3)) p.push(`glossed: ${JSON.stringify(g.text)} (write only the ${LANG_NAME[tgt]} words, no ${LANG_NAME[src]} and no parentheses)`);
    if (isVarRule(k)) {
      for (const w of pinnable(k, text)) p.push(`state value "${w}" not kept verbatim`);
    }
    if (isText(k)) {
      const check = await rx.check(units[k]!, text, lit.patterns, playerFacing.has(k));
      for (const pat of check.lost) p.push(`format marker lost: ${pat.sample ? JSON.stringify(pat.sample.trim()) : pat.src.slice(0, 60)} (copy it exactly)`);
      for (const m of check.markers) if (!p.some((x) => x.includes(m))) p.push(`format marker lost: ${JSON.stringify(m)} (copy it exactly)`);
      for (const w of lostValues(units[k]!, text, codeMatched)) p.push(`state value "${w}" not kept verbatim`);
    }
    return p;
  };
  const problemsOf = async (k: string) => (k in out ? problemsIn(k, out[k]!) : ["missing"]);
  const failing: string[] = [];
  for (const k of keys) if ((await problemsOf(k)).length) failing.push(k);
  await pool(failing, 3, async (k) => {
    const before = await problemsOf(k);
    try {
      const r = parseJsonObject((await call([{ role: "system", content: rulesText }, { role: "user", content: `A previous translation of this text had problems: ${before.join("; ")}. Translate it again and fix them. Every sentence, examples included, must be in ${LANG_NAME[tgt]} (state values, format markers, ids and placeholders excepted). Do not repeat any paragraph.\n${JSON.stringify({ [k]: protectedUnits[k]!.text })}` }], { json: true, maxTokens: 16000 })).text);
      const restored = typeof r[k] === "string" ? restore(r[k] as string, protectedUnits[k]!.spans, protectedUnits[k]!.salt) : null;
      if (restored != null && (await problemsIn(k, restored)).length < before.length) { out[k] = restored; report.repaired++; }
    } catch (e) {
      if (!(k in out)) failedWith[k] = /refus/i.test(String((e as Error).message)) ? "refused" : "error";
    }
  });

  // Still lost after the retry: put the markers back ourselves (the translated words stay), and tell the
  // narrator in the target language to write the code-matched values of a variable as they are.
  for (const k of keys) {
    if (!(k in out)) continue;
    // Glosses the retry kept: drop the source-language half (before the markers go back, so a marker
    // value glossed as "Neutral (нейтрально)" is put back whole by the label restore).
    if (playerFacing.has(k)) out[k] = stripGlosses(units[k]!, out[k]!, src, tgt, state);
    if (isText(k)) {
      const check = await rx.check(units[k]!, out[k]!, lit.patterns, playerFacing.has(k));
      if (check.lost.length || check.markers.length) {
        const r = await rx.restore(units[k]!, out[k]!, lit, playerFacing.has(k));
        if (r.restored) { out[k] = r.text; report.markersRestored += r.restored; }
      }
    }
    if (isVarRule(k) && !(k.endsWith(".description") && k.replace(/description$/, "behaviorRules") in units)) {
      const lost = pinnable(k, out[k]!);
      if (lost.length) { out[k] = out[k]!.replace(/\s*$/, "") + valueNote(tgt, lost); report.valuesPinned++; }
    }
  }

  // 3. Keywords (lorebook triggers must match what players and the narrator now write). In batches: DanMachi's
  // 609 entries in one call failed and every keyword stayed English. A failed batch keeps only its own entries'
  // source keywords. What comes back is filtered (card-translate-keywords.ts) before it is used.
  const kw: Record<string, string[]> = {};
  entries.forEach((e, i) => {
    if (Array.isArray(e.keywords) && e.keywords.length) kw[`entry.${i}.keywords`] = e.keywords;
    if (Array.isArray(e.secondaryKeywords) && e.secondaryKeywords.length) kw[`entry.${i}.secondaryKeywords`] = e.secondaryKeywords;
  });
  const kwKeys = Object.keys(kw);
  const kwRaw: Record<string, string[]> = {};
  const kwBatches: string[][] = [];
  { let cur: string[] = [], size = 0;
    for (const k of kwKeys) {
      const n = JSON.stringify(kw[k]).length;
      if (cur.length && (cur.length >= KEYWORD_BATCH || size + n > KEYWORD_BATCH_CHARS)) { kwBatches.push(cur); cur = []; size = 0; }
      cur.push(k); size += n;
    }
    if (cur.length) kwBatches.push(cur); }
  const kwSystem = keywordPrompt(LANG_NAME[tgt], tgt, glossary);
  let kwFailed = 0, kwDone = 0;
  onProgress?.("keywords", 0, kwBatches.length || 1);
  const runKw = async (b: string[]): Promise<void> => {
    for (let t = 0; t < 2 && b.length; t++) {
      try {
        const r = parseJsonObject((await call([{ role: "system", content: kwSystem }, { role: "user", content: JSON.stringify(Object.fromEntries(b.map((k) => [k, kw[k]]))) }], { json: true, maxTokens: 12000 })).text);
        for (const k of b) { const v = r[k]; if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) kwRaw[k] = v as string[]; }
        b = b.filter((k) => !(k in kwRaw));
      } catch (e) {
        if (isTruncation(String((e as Error).message)) && b.length > 1) {
          const half = Math.ceil(b.length / 2);
          await runKw(b.slice(0, half)); await runKw(b.slice(half));
          return;
        }
      }
    }
    kwFailed += b.filter((k) => !(k in kwRaw)).length;
  };
  await pool(kwBatches, 4, async (b) => { await runKw(b); kwDone++; onProgress?.("keywords", kwDone, kwBatches.length); });
  if (kwFailed) report.warnings.push(`keyword translation failed for ${kwFailed} of ${kwKeys.length} keyword lists; those keep their ${LANG_NAME[src]} keywords`);
  const kwClean = cleanKeywords({
    tgt, glossary, original: kw, proposed: kwRaw,
    entries: entries.map((e, i) => ({ srcName: String(e.name ?? ""), srcText: String(e.content ?? ""), name: String(out[`entry.${i}.name`] ?? e.name ?? ""), text: String(out[`entry.${i}.content`] ?? e.content ?? ""), matchWholeWords: !!e.matchWholeWords && isLatinLang(tgt) })),
  });
  const kwOut = kwClean.keywords;
  if (kwClean.dropped.length) report.warnings.push(`keywords dropped: ${kwClean.dropped.length} (${[...new Set(kwClean.dropped.map((d) => d.why))].join(", ")}): ${kwClean.dropped.slice(0, 8).map((d) => d.keyword).join(", ")}`);
  onProgress?.("keywords", kwBatches.length || 1, kwBatches.length || 1);

  // 4. Interface (TSX)
  const tsxOut: Record<string, string> = {};
  const tsxTodo = files.filter(([, code]) => hasVisibleProse(code, src));
  const tsxRules = `You localize one file of a game's React (TSX) interface from ${LANG_NAME[src]} into ${LANG_NAME[tgt]}. Return the COMPLETE file in one \`\`\`tsx block, nothing else.
Translate ONLY text a player reads on screen: JSX text, aria-label/title/placeholder text, display strings in label maps and string tables (const STR = { ... }), captions and fallback text. Translate plainly: never leave a ${LANG_NAME[src]} word next to its translation or add a translation in parentheses.
Never change: code, className / CSS / style values, ids, object keys, import paths, data-* attributes, any string compared with === / !== / switch-case / includes, variable ids (${varIds.join(", ")}), and these state values: ${stateValues.filter((w) => logic.has(w)).join(", ") || "(none)"}. Values of name, id, key, value, type, kind, state or mode fields stay exactly as written even when they are character names (the code looks them up); translate the label shown next to them instead. Keep every line without player-visible text byte-identical. Glossary: ${JSON.stringify(glossary)}`;
  // Interface texts translated one by one get their own rules (no state values to keep: those are never sent).
  const uiText = uiRules(src, tgt, glossary);
  /** Translate picked-out display strings in batches; a batch cut off at the output cap is split, never resent whole. */
  const translateStrings = async (items: DisplayString[]): Promise<Record<string, string>> => {
    const map: Record<string, string> = {};
    const batches: DisplayString[][] = [];
    let cur: DisplayString[] = [], size = 0;
    for (const it of items) {
      if (cur.length && (size + it.text.length > UI_BATCH_CHARS || cur.length >= 150)) { batches.push(cur); cur = []; size = 0; }
      cur.push(it); size += it.text.length;
    }
    if (cur.length) batches.push(cur);
    const run = async (b: DisplayString[]): Promise<void> => {
      for (let t = 0; t < 2 && b.length; t++) {
        try {
          const r = parseJsonObject((await call([{ role: "system", content: uiText }, { role: "user", content: JSON.stringify(Object.fromEntries(b.map((i) => [i.id, i.text])), null, 1) }], { json: true, maxTokens: 16000 })).text);
          for (const i of b) { const v = r[i.id]; if (typeof v === "string" && v.trim()) map[i.id] = stripGlosses(i.text, v, src, tgt, logic); }
          b = b.filter((i) => !(i.id in map));
        } catch (e) {
          if (isTruncation(String((e as Error).message)) && b.length > 1) {
            const half = Math.ceil(b.length / 2);
            await run(b.slice(0, half)); await run(b.slice(half));
            return;
          }
        }
      }
    };
    await pool(batches, 3, run);
    return map;
  };
  let tDone = 0;
  await pool(tsxTodo, 3, async ([name, code]) => {
    let last = "";
    // A file this big cannot come back whole inside the output cap (Draco Malfoy's 167k-char interface with its
    // STR table was cut off on every try, then its one-call string pass too): go straight to the string pass.
    if (code.length > WHOLE_FILE_MAX) last = `file too large for a whole-file rewrite (${code.length} chars)`;
    else for (let t = 0; t < 3; t++) {
      try {
        const reply = (await call([{ role: "system", content: tsxRules }, { role: "user", content: `File ${name}:\n\`\`\`tsx\n${code}\n\`\`\`` }], { maxTokens: 32000 })).text;
        const m = reply.match(/```(?:tsx|ts|jsx|typescript)?\s*\n([\s\S]*?)```/);
        if (!m) { last = "no code block"; continue; }
        const next = m[1]!.replace(/\s+$/, "") + (code.endsWith("\n") ? "\n" : "");
        // A model handed a huge data file abbreviated it ("arcs":[...]) and the card broke: a rewrite
        // far shorter than the file is a cut, not a translation.
        if (code.length > 2000 && next.length < code.length * 0.5) { last = `rewrite is ${next.length} of ${code.length} chars`; continue; }
        const problems = checkTsxRewrite(code, next, logic);
        if (problems.length) { last = problems[0]!; continue; }
        tsxOut[name] = next; break;
      } catch (e) { last = (e as Error).message; }
    }
    // The model kept touching logic (or the file is too big): translate only the display strings we pick out,
    // and put them back ourselves. Values used as keys or comparisons are never sent, so the code cannot change.
    if (!tsxOut[name]) {
      const items = extractDisplayStrings(code, src, logic);
      if (items.length) {
        try {
          const map = await translateStrings(items);
          const missing = items.filter((i) => !(i.id in map)).length;
          if (missing > items.length * 0.2) last = `${missing} of ${items.length} interface texts did not come back`;
          else {
            const next = applyDisplayStrings(code, items, map);
            const problems = checkTsxRewrite(code, next, logic);
            if (!problems.length) {
              tsxOut[name] = next; report.tsxPartial.push(name);
              if (missing) report.warnings.push(`interface file ${name}: ${missing} of ${items.length} texts left in ${LANG_NAME[src]}`);
            } else last = problems[0]!;
          }
        } catch (e) { last = (e as Error).message; }
      }
    }
    // A card that keeps its texts in a string table and names its language (const LANG = "en") now speaks the
    // target language: say so, the way the card's own build step does for each language it ships.
    if (tsxOut[name]) tsxOut[name] = retargetLang(tsxOut[name]!, src, tgt);
    if (!tsxOut[name]) { report.tsxKeptOriginal.push(name); report.issues.push(`interface file ${name} left in ${LANG_NAME[src]} (${last})`); }
    tDone++; onProgress?.("interface", tDone, tsxTodo.length);
  });
  report.tsxTranslated = Object.keys(tsxOut);

  // 5. Assemble
  onProgress?.("checks", 0, 1);
  const T = (k: string, fallback: any) => out[k] ?? fallback;
  const schema = JSON.parse(JSON.stringify(S)) as Record<string, any>;
  let name = String(T("meta.name", input.name)).replace(/^《(.*)》$/, "$1").replace(/^"(.*)"$/, "$1").trim();
  // A title that is just a character's name comes back untouched ("Marin Kitagawa" stayed
  // English on a Chinese version while the text used 喜多川海梦): apply the glossary to it.
  if (!isLatinLang(tgt) && !inScript(tgt, name)) {
    for (const [k, v] of Object.entries(glossary).sort((a, b) => b[0].length - a[0].length)) {
      if (k !== BRAND && inScript(tgt, v) && name.includes(k)) name = name.split(k).join(v);
    }
  }
  const description = T("meta.description", input.description);
  schema.name = name; schema.description = description;
  (schema.entries ?? []).forEach((e: any, i: number) => {
    e.name = T(`entry.${i}.name`, e.name);
    e.content = T(`entry.${i}.content`, e.content);
    if (kwOut[`entry.${i}.keywords`]) e.keywords = kwOut[`entry.${i}.keywords`];
    if (kwOut[`entry.${i}.secondaryKeywords`]) e.secondaryKeywords = kwOut[`entry.${i}.secondaryKeywords`];
    // Chinese has no word boundaries; Korean glues particles onto words (엘리스가, 엘리스를); Russian
    // inflects them (ведьма, ведьмы, ведьму), so its keywords are stems matched inside words.
    if (!isLatinLang(tgt) && e.matchWholeWords) e.matchWholeWords = false;
  });
  // A default the final interface code still quotes word for word is state the code checks
  // (a kept-original file, a record compared field by field): it stays in the source language.
  const finalCode = files.map(([name, code]) => tsxOut[name] ?? code).join("\n");
  const quotedInCode = (t: string) => finalCode.includes(JSON.stringify(t)) || finalCode.includes(`'${t.replace(/'/g, "\\'")}'`);
  for (const leaf of defaultLeaves) {
    const v = schema.variables?.[leaf.i];
    if (!v || !(leaf.key in out)) continue;
    if (quotedInCode(units[leaf.key]!)) continue;
    if (!leaf.path.length) { v.defaultValue = out[leaf.key]; continue; }
    let node = v.defaultValue;
    for (const step of leaf.path.slice(0, -1)) node = node?.[step];
    if (node && typeof node === "object") node[leaf.path[leaf.path.length - 1]!] = out[leaf.key];
  }
  (schema.variables ?? []).forEach((v: any, i: number) => {
    v.name = T(`var.${i}.name`, v.name);
    if (v.description != null) v.description = T(`var.${i}.description`, v.description);
    if (v.behaviorRules != null) v.behaviorRules = T(`var.${i}.behaviorRules`, v.behaviorRules);
  });
  (schema.rules ?? []).forEach((r: any, i: number) => {
    r.name = T(`rule.${i}.name`, r.name); r.description = T(`rule.${i}.description`, r.description);
    (r.actions ?? []).forEach((a: any, j: number) => { if (a.message != null) a.message = T(`rule.${i}.action.${j}.message`, a.message); });
  });
  schema.settings = schema.settings ?? {};
  if (greetingIsEntry) schema.settings.greeting = schema.entries[greetIdx].content;
  else if (settings.greeting != null) schema.settings.greeting = T("settings.greeting", settings.greeting);
  if (settings.systemPrompt) schema.settings.systemPrompt = T("settings.systemPrompt", settings.systemPrompt);
  if (/^(you|player|你|玩家|tú|jugador|당신|플레이어|kamu|pemain|ты|игрок)$/i.test(String(settings.playerName ?? ""))) schema.settings.playerName = PLAYER_YOU[tgt];
  for (const [file, code] of Object.entries(tsxOut)) {
    const f = schema.rootComponent.files[file];
    if (typeof f === "string") schema.rootComponent.files[file] = code; else f.content = code;
  }
  // The stored precompiled bundle no longer matches the files; the renderer recompiles when the hash differs.
  if (Object.keys(tsxOut).length && schema.rootComponent?.compiled) delete schema.rootComponent.compiled;

  // Chinese chats write fewer directives; tell the narrator in Chinese (only when the card has state).
  if (tgt === "zh" && variables.length) {
    const main = schema.entries.find((e: any) => e.role === "system" && e.alwaysSend !== false && e.enabled !== false);
    if (main && !main.content.includes(DIRECTIVE_REMINDER_ZH_HEADER)) main.content += DIRECTIVE_REMINDER_ZH;
  }

  // 6. Final checks: a technical line for logs (issues) and a structured one for the creator (problems).
  const whereOf = (k: string): { field: TranslateProblem["field"]; where: string } => {
    let m: RegExpMatchArray | null;
    if (k === "meta.name") return { field: "title", where: "" };
    if (k.startsWith("meta.")) return { field: "description", where: "" };
    if (k === "settings.greeting") return { field: "opening", where: "" };
    if (k === "settings.systemPrompt") return { field: "entry", where: "" };
    if ((m = k.match(/^entry\.(\d+)\./))) { const i = Number(m[1]); return { field: entries[i]?.role === "greeting" ? "opening" : "entry", where: String(out[`entry.${i}.name`] ?? entries[i]?.name ?? "") }; }
    if ((m = k.match(/^var\.(\d+)\./))) { const i = Number(m[1]); return { field: "variable", where: String(out[`var.${i}.name`] ?? variables[i]?.name ?? variables[i]?.id ?? "") }; }
    if ((m = k.match(/^rule\.(\d+)\./))) { const i = Number(m[1]); return { field: "behavior", where: String(out[`rule.${i}.name`] ?? rules[i]?.name ?? "") }; }
    return { field: "entry", where: k };
  };
  for (const k of keys) {
    for (const p of await problemsOf(k)) {
      report.issues.push(`${label(k, entries)}: ${p}`);
      const kind: TranslateProblem["kind"] = p === "missing" ? (failedWith[k] === "refused" ? "refused" : "missing") : problemKind(p);
      report.problems.push({ kind, ...whereOf(k), detail: p });
    }
  }
  for (const f of report.tsxKeptOriginal) report.problems.push({ kind: "interface_kept", field: "interface", where: f, detail: "" });
  report.unitsTotal = keys.length;
  report.unitsMissing = keys.filter((k) => !(k in out)).length;
  report.unitsRefused = keys.filter((k) => !(k in out) && failedWith[k] === "refused").length;
  onProgress?.("checks", 1, 1);

  return {
    name, description,
    extendedDescription: input.extendedDescription ? T("meta.extended_description", input.extendedDescription) : input.extendedDescription ?? null,
    announcement: input.announcement ? T("meta.announcement", input.announcement) : input.announcement ?? null,
    schema, report,
  };
}

export const DIRECTIVE_REMINDER_ZH_HEADER = "## 状态指令（必须遵守）";
export const DIRECTIVE_REMINDER_ZH = `\n\n${DIRECTIVE_REMINDER_ZH_HEADER}\n每条回复写完叙述后，另起一行，用英文方括号格式写出本回合发生变化的每个状态，例如 [affection: +3] 或 [mood: set "值"]。变量名、冒号和 set/append 等操作词保持英文原样，不要翻译，也不要省略。只在叙述里描写变化而不写指令，状态就不会改变。`;

function label(k: string, entries: any[]): string {
  const m = k.match(/^entry\.(\d+)\.(\w+)$/);
  return m ? `entry "${entries[Number(m[1])]?.name ?? m[1]}" ${m[2]}` : k;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()!); }));
}
