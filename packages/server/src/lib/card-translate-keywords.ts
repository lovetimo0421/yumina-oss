/**
 * Lorebook keywords for a translated card: what to ask the model for, and which of its answers to keep.
 *
 * At play time (engine lorebook/keyword-matcher.ts) a keyword fires when it appears anywhere in the recent chat,
 * case-insensitively, as a substring; only an entry with matchWholeWords checks word edges, and a keyword written
 * /pattern/flags is tested as a regex first. Russian and Korean versions switch whole words off (their words
 * inflect or take particles), so every translated keyword there is a substring.
 *
 * DanMachi, Russian (2026-11-21, 609 entries): sent in one call, the keywords failed and all stayed English; sent
 * in batches they came back with stems like «ма» (inside мама, мать, магия), «авантюрист» and «госпож» (in most of
 * the card's text), and a few mapped to the wrong entry. So: batches with a per-batch fallback, and a filter that
 * drops too-short and too-generic forms, makes short names match at a word start only (a Unicode-aware regex, no
 * lookbehind so it also runs in older browsers), and drops a form that names another entry's subject.
 */
import { keywordMatches } from "@yumina/engine";

export type KeywordLang = "en" | "zh" | "es" | "ko" | "id" | "ru";

export interface KeywordEntry {
  /** Source-language name and text, and the target-language ones (after the prose pass). */
  srcName: string; srcText: string;
  name: string; text: string;
  matchWholeWords: boolean;
}

export interface KeywordDrop { key: string; keyword: string; why: "short" | "generic" | "mismapped" | "elsewhere" | "invalid" }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
const hangul = (s: string) => (s.match(/[가-힣]/g) ?? []).length;
const cjk = (s: string) => (s.match(/[一-鿿]/g) ?? []).length;
const EDGE = "(?:^|[^\\p{L}\\p{N}_])";
const END = "(?![\\p{L}\\p{N}_])";
/**
 * Endings a short word may still take at play time: Russian case endings (not any three letters: Сир + ота is
 * сирота), Indonesian clitics, a plural.
 */
const SUFFIX: Partial<Record<KeywordLang, string>> = { ru: "(?:а|я|у|ю|е|ы|и|ь|ой|ей|ою|ею|ом|ем|ам|ям|ах|ях|ов|ев|ью|ами|ями)?", id: "(?:nya|lah|kah|pun|ku|mu)?", es: "(?:s|es)?", en: "(?:s|es|'s)?" };

/** A word-start regex keyword: `сир` -> /(?:^|[^\p{L}\p{N}_])сир(?:а|у|ой|…)?(?![\p{L}\p{N}_])/iu. */
export function wordStartKeyword(word: string, lang: KeywordLang, exact = false): string {
  const w = esc(word.toLowerCase());
  if (lang === "ko" || lang === "zh") return `/${EDGE}${w}/iu`; // particles follow a Korean word: only its start is an edge
  return `/${EDGE}${w}${exact ? "" : SUFFIX[lang] ?? ""}${END}/iu`;
}

/** The system prompt for one keyword batch. */
export function keywordPrompt(tgtName: string, tgt: KeywordLang, glossary: Record<string, string>): string {
  const morph = tgt === "ru"
    ? " Russian words change their endings (ведьма, ведьмы, ведьму) and these keywords match anywhere inside a word, so give the stem every case form starts with (ведьм, дракон, академи), at least 4 letters, rather than one inflected form."
    : tgt === "ko" ? " Korean attaches particles (엘리스가, 엘리스를) and these keywords match anywhere inside the text, so give the bare noun without particles."
    : tgt === "id" ? " Give base words (pedang, not pedangnya), and names exactly as in the glossary."
    : "";
  return `Lorebook entries trigger when a keyword appears in the chat. The chat will now be in ${tgtName}. For each key, return an array: the ${tgtName} words a player or narrator would actually write for that concept (2-4 short forms each; glossary ${JSON.stringify(glossary)}), followed by the original keywords.${morph} Only words specific to that entry: never a common word that would appear in most of this world's text (adventurer, lady, city, goddess) unless the original keyword is that word. JSON only, same keys.`;
}

/**
 * Keep the model's keywords that will fire where they should. `proposed` and `original` are keyed
 * `entry.<i>.keywords` / `entry.<i>.secondaryKeywords`. Every original keyword is kept (English chats and
 * English state values still trigger); a translated form is dropped when it is
 *  - short: under 2 letters (Korean / Chinese: one syllable / character) unless it is a glossary name;
 *  - mismapped: the glossary's form of a name that is not among this entry's own keywords or name;
 *  - generic: it fires on many of the card's entries (at least 6 and 5%), far more than this entry's own source
 *    keywords did in the source, and it is neither a glossary name nor part of the entry's own name;
 *  - elsewhere: it fires mostly on entries this entry's own source keywords never fired on in the source (at
 *    least 3, more than where they did): it names something else. A form that fires where the source keywords
 *    fired too (Bell's nickname in every "Bell · Now" entry) is the same subject.
 * A short form that stays (3-4 letters, or a 2-letter glossary name) becomes a word-start regex.
 */
export function cleanKeywords(opts: {
  tgt: KeywordLang;
  glossary: Record<string, string>;
  entries: KeywordEntry[];
  original: Record<string, string[]>;
  proposed: Record<string, string[]>;
}): { keywords: Record<string, string[]>; dropped: KeywordDrop[] } {
  const { tgt, glossary, entries, original, proposed } = opts;
  const dropped: KeywordDrop[] = [];
  const glossTo = new Map<string, string[]>(); // target form (lowercase) -> the source terms the glossary gives it for
  for (const [k, v] of Object.entries(glossary)) if (typeof v === "string" && v.trim() && k !== v) glossTo.set(v.trim().toLowerCase(), [...(glossTo.get(v.trim().toLowerCase()) ?? []), k]);
  const isGlossName = (kw: string) => glossTo.has(kw.toLowerCase());
  const texts = entries.map((e) => `${e.name}\n${e.text}`);
  const srcTexts = entries.map((e) => `${e.srcName}\n${e.srcText}`);
  const floor = Math.max(6, Math.ceil(entries.filter((e) => e.text.trim()).length * 0.05));

  // 1. Per keyword: shape checks, and the form it will be stored in.
  type Cand = { key: string; i: number; kw: string; stored: string; ww: boolean };
  const cands: Cand[] = [];
  const out: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(proposed)) {
    const m = key.match(/^entry\.(\d+)\./);
    const i = m ? Number(m[1]) : -1;
    const e = entries[i];
    const orig = original[key] ?? [];
    if (!e) continue;
    const origLower = new Set(orig.map((x) => x.toLowerCase()));
    const own = [...orig, e.srcName].map((x) => x.toLowerCase());
    const seen = new Set<string>();
    out[key] = [];
    for (const raw of list) {
      const kw = typeof raw === "string" ? raw.trim() : "";
      const low = kw.toLowerCase();
      if (!kw || origLower.has(low) || seen.has(low)) continue;
      seen.add(low);
      if (kw.startsWith("/")) {
        const r = kw.match(/^\/(.+)\/([gimsuy]*)$/);
        try { if (!r) throw new Error(); new RegExp(r[1]!, r[2]); cands.push({ key, i, kw, stored: kw, ww: e.matchWholeWords }); } catch { dropped.push({ key, keyword: kw, why: "invalid" }); }
        continue;
      }
      // The glossary's form of a name this entry is not about (Riveria's entry handed the town Rivira's name).
      const terms = glossTo.get(low);
      const term = !!terms;
      if (terms && !terms.some((t) => own.some((o) => o.includes(t.toLowerCase()) || t.toLowerCase().includes(o)))) { dropped.push({ key, keyword: kw, why: "mismapped" }); continue; }
      const spaced = /\s/.test(kw);
      let stored = kw;
      if (!spaced) {
        if (tgt === "ko" && hangul(kw) && hangul(kw) === letters(kw)) {
          if (hangul(kw) < 2 && !term) { dropped.push({ key, keyword: kw, why: "short" }); continue; }
          if (hangul(kw) <= 2) stored = wordStartKeyword(kw, tgt);
        } else if (tgt === "zh" && cjk(kw) === letters(kw)) {
          if (cjk(kw) < 2 && !term) { dropped.push({ key, keyword: kw, why: "short" }); continue; }
        } else {
          const n = letters(kw);
          if (n < 2 || (n === 2 && !term)) { dropped.push({ key, keyword: kw, why: "short" }); continue; }
          if (n <= 4) stored = wordStartKeyword(kw, tgt, n === 2);
        }
      }
      cands.push({ key, i, kw, stored, ww: e.matchWholeWords });
    }
  }

  // 2. Where each form fires among the card's own (translated) entries, with the matcher the engine uses.
  const df = new Map<Cand, Set<number>>();
  for (const c of cands) df.set(c, new Set());
  texts.forEach((t, j) => { for (const c of cands) if (keywordMatches(t, c.stored, c.ww)) df.get(c)!.add(j); });
  const srcDf = new Map<string, Set<number>>();
  const srcHits = (kw: string, ww: boolean) => {
    const k = `${ww ? 1 : 0}\u0000${kw}`;
    let n = srcDf.get(k);
    if (n == null) { const s = new Set<number>(); srcTexts.forEach((t, j) => { if (keywordMatches(t, kw, ww)) s.add(j); }); srcDf.set(k, s); n = s; }
    return n;
  };

  for (const c of cands) {
    const e = entries[c.i]!;
    const hits = df.get(c)!;
    if (isGlossName(c.kw) || keywordMatches(e.name, c.stored, c.ww)) { out[c.key]!.push(c.stored); continue; }
    const origHits = (original[c.key] ?? []).map((k) => srcHits(k, c.ww));
    if (hits.size >= floor && hits.size > Math.max(0, ...origHits.map((h) => h.size)) * 2) { dropped.push({ key: c.key, keyword: c.kw, why: "generic" }); continue; }
    // Where this entry's own source keywords fired in the source (and the entry itself): firing there is the same subject.
    const where = new Set<number>([c.i]);
    for (const h of origHits) for (const j of h) where.add(j);
    let inside = 0, outside = 0;
    for (const j of hits) if (where.has(j)) inside++; else outside++;
    if (outside >= 3 && outside > inside) { dropped.push({ key: c.key, keyword: c.kw, why: "elsewhere" }); continue; }
    out[c.key]!.push(c.stored);
  }
  for (const key of Object.keys(out)) {
    const orig = original[key] ?? [];
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const k of [...out[key]!, ...orig]) { const l = k.toLowerCase(); if (!seen.has(l)) { seen.add(l); merged.push(k); } }
    out[key] = merged;
  }
  return { keywords: out, dropped };
}
