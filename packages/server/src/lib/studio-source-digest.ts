/**
 * Digest a source text into a canon reference ("原著资料库") the assistant can
 * write a fan-work card from.
 *
 * A card built from a novel of a few million characters cannot have the novel
 * in the prompt, and search alone does not tell the assistant what the book
 * IS — who matters, how the plot turns, what the world's rules are. So the
 * book is read the way a person with helpers would read it:
 *
 *   1. cut into parts at chapter boundaries (~60k characters each);
 *   2. every part read by a model in parallel, writing notes in one format
 *      (plot by chapter, people, factions, places, terms, timeline, quotes);
 *   3. every quote in the notes checked word for word against the part it
 *      came from — anything that is not there is marked 〔未核实〕;
 *   4. the notes regrouped by topic in code (each person's lines across the
 *      whole book, every part's plot in order…);
 *   5. one model call per topic merges its group into a section — a long
 *      topic is cut into several (~25k characters of notes each), so every
 *      section is one the model can finish;
 *   6. each section's open questions ("the notes disagree…") are checked:
 *      the model names what to search for, the server searches the source,
 *      and the model settles the question from the excerpts;
 *   7. the sections are stored with the card as one more source text, which
 *      the assistant reads with read_source like the book itself.
 *
 * Notes are kept per part in storage, so a digest that is stopped (or runs
 * out of mushies) resumes without paying for the parts already read. A digest
 * belongs to the card, not to the chat turn that started it (runDigest).
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./llm/types.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { resolveProviderForModel } from "./resolve-provider.js";
import { usageObservation } from "./usage-observation.js";
import { recordUsageLog } from "./usage-log.js";
import { billBackgroundUsage, hasBackgroundRunBudget, notEnoughMushiesMessage } from "./background-billing.js";
import { getModelPrice, type ModelPriceEntry } from "./model-price-cache.js";
import { generateWithSummaryFallback } from "./summary-fallback.js";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { usageLogs } from "../db/schema.js";
import { getObjectBuffer, headObject, putObject } from "./s3.js";
import {
  addSource, listSources, loadSourceText, removeSource, searchText, sourceDigestPrefix,
  type SourceHit, type SourceMeta,
} from "./studio-sources.js";

export const DIGEST_ENDPOINT = "source-digest";
/**
 * Measured on a 6.7M-character novel (2026-10-01): deepseek-v4-flash quotes
 * the book as faithfully as gemini-2.5-flash (97% vs 98% of quotes verbatim)
 * at a quarter of the price, refuses nothing, and — unlike gemini — does not
 * fall into repeating itself in long merged sections. It is slower per call,
 * which more calls at once make up for.
 */
export const DIGEST_READER_MODEL = process.env.SOURCE_DIGEST_READER_MODEL || "deepseek/deepseek-v4-flash";
export const DIGEST_MERGE_MODEL = process.env.SOURCE_DIGEST_MERGE_MODEL || "deepseek/deepseek-v4-flash";
/** Where a call goes when a model's content filter refuses it (many fan-work sources are violent or explicit). */
const DIGEST_REFUSAL_FALLBACK_MODEL = "deepseek/deepseek-v3.2";
const PART_CHARS = 60_000;
const CONCURRENCY = 12;
const MERGE_CONCURRENCY = 10;
const NOTE_MAX_TOKENS = 8_000;
const SECTION_MAX_TOKENS = 12_000;
/** No single call runs longer than this; slow upstreams manage ~30 tokens a second. */
const CALL_MAX_MS = 8 * 60_000;
export const BIBLE_SUFFIX = "·原著资料库.md";

// ── Parts ──────────────────────────────────────────────────────────────────

export interface DigestPart { index: number; start: number; end: number; first: string; last: string }

/** Whole chapters (they are ≤30k already) packed up to ~60k characters. */
export function planParts(meta: SourceMeta, size = PART_CHARS): DigestPart[] {
  const parts: DigestPart[] = [];
  let cur: DigestPart | null = null;
  for (const ch of meta.chapters) {
    if (cur && ch.end - cur.start > size) { parts.push(cur); cur = null; }
    if (!cur) cur = { index: parts.length, start: ch.start, end: ch.end, first: ch.title, last: ch.title };
    else { cur.end = ch.end; cur.last = ch.title; }
  }
  if (cur) parts.push(cur);
  return parts;
}

// ── Estimate ───────────────────────────────────────────────────────────────

/** Tokens for a stretch of text: CJK runs about one token per 1.25 characters
 *  on these tokenizers, the rest about four characters a token. */
export function approxTokens(text: string): number {
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  return Math.ceil(cjk * 0.8 + (text.length - cjk) / 4);
}

function callCost(price: ModelPriceEntry | null, inTok: number, outTok: number): number | null {
  if (!price) return null;
  const mushies = (inTok * price.inputPricePerM + outTok * price.outputPricePerM) * (price.markupMultiplier ?? 1) / 1000;
  return Number.isFinite(mushies) ? mushies : null;
}

/**
 * How much more than the price table the provider really charged for recent
 * digest calls on these models (1.5 when there is no history yet).
 */
async function providerOverTable(models: string[]): Promise<number> {
  try {
    const rows = await db.select({
      model: usageLogs.model, prompt: usageLogs.promptTokens, completion: usageLogs.completionTokens, usd: usageLogs.providerCostUsd,
    }).from(usageLogs)
      .where(and(eq(usageLogs.endpoint, DIGEST_ENDPOINT), inArray(usageLogs.model, models.map(applyModelRedirect)), isNotNull(usageLogs.providerCostUsd)))
      .orderBy(desc(usageLogs.createdAt)).limit(400);
    let charged = 0; let table = 0;
    for (const row of rows) {
      const price = await getModelPrice(row.model);
      if (!price) continue;
      charged += Number(row.usd);
      table += (row.prompt * price.inputPricePerM + row.completion * price.outputPricePerM) / 1_000_000;
    }
    return rows.length >= 20 && table > 0 ? Math.min(4, Math.max(1, charged / table)) : 1.5;
  } catch {
    return 1.5;
  }
}

export interface DigestEstimate { parts: number; minutes: number; mushies: number | null; plan: string[] }

/** `alreadyRead`: parts a stopped run left notes for; they are not read (or paid for) again. */
export async function estimateDigest(meta: SourceMeta, sample: string, byKey: boolean, alreadyRead = 0): Promise<DigestEstimate> {
  const parts = planParts(meta).length;
  const toRead = Math.max(0, parts - alreadyRead);
  const tokensPerChar = approxTokens(sample.slice(0, 200_000)) / Math.max(1, Math.min(sample.length, 200_000));
  const sourceTokens = meta.chars * tokensPerChar;
  const notesTokens = parts * 4_500;
  const reader = byKey ? null : await getModelPrice(applyModelRedirect(DIGEST_READER_MODEL));
  const merger = byKey ? null : await getModelPrice(applyModelRedirect(DIGEST_MERGE_MODEL));
  const read = callCost(reader, (sourceTokens + parts * 1_500) * toRead / parts, notesTokens * toRead / parts);
  // Merge reads the notes about once and writes one section per ~25k of
  // notes; checking reads each section's open lines plus excerpts and writes
  // a few lines back.
  const sections = Math.min(80, 10 + Math.ceil(parts / 4));
  const merge = callCost(merger, notesTokens * 1.3 + sections * 6_000, sections * 9_000);
  const check = callCost(merger, sections * 18_000, sections * 1_500);
  // Billing uses what the provider reports it charged, which can run ahead of
  // the price table; the estimate follows what recent digests really cost.
  const lag = byKey ? 1 : await providerOverTable([DIGEST_READER_MODEL, DIGEST_MERGE_MODEL]);
  const total = read !== null && merge !== null && check !== null ? (read + merge + check) * lag : null;
  const mushies = total === null ? null : total < 20 ? Math.max(1, Math.ceil(total)) : Math.ceil(total / 10) * 10;
  // Measured: a part takes about a minute to read, a section up to three to merge.
  const minutes = Math.max(3, Math.ceil(Math.ceil(toRead / CONCURRENCY) + Math.ceil(sections / MERGE_CONCURRENCY) * 3 + 4));
  const wan = meta.chars >= 10_000 ? `${Math.round(meta.chars / 10_000)} 万字` : `${meta.chars} 字`;
  return {
    parts, minutes, mushies,
    plan: [
      toRead < parts
        ? `接着上次读「${meta.name}」（${wan}）：${parts} 段里已读 ${alreadyRead} 段，${toRead ? `再读剩下 ${toRead} 段` : "不用再读"}`
        : `通读「${meta.name}」全书（${wan}），分 ${parts} 段同时读，每段写一份笔记`,
      "逐字核对笔记里的原文引用，对不上的标出来",
      "按剧情、人物、势力、世界、文风合并成资料库",
      "把资料库里前后矛盾的地方拿回原文查清",
      "资料库存进这张卡，之后写卡时随时查",
    ],
  };
}

/** How many parts of this book already have notes from an earlier run. */
export async function countReadParts(userId: string, worldId: string, meta: SourceMeta): Promise<number> {
  const dir = sourceDigestPrefix(userId, worldId, meta.id);
  const parts = planParts(meta);
  let read = 0;
  for (let i = 0; i < parts.length; i += 25) {
    const found = await Promise.all(parts.slice(i, i + 25).map((p) =>
      headObject(`${dir}notes-${String(p.index).padStart(3, "0")}.md`).then(Boolean, () => false)));
    read += found.filter(Boolean).length;
  }
  return read;
}

// ── One model call (usage recorded, mushies charged) ───────────────────────

export class DigestStopped extends Error {}

type CallArgs = {
  userId: string; model: string; system: string; user: string; maxTokens: number; signal?: AbortSignal;
  /** How many times a reply cut off at maxTokens may be continued. */
  continuations?: number;
  temperature?: number;
};
type OnceArgs = CallArgs & { soFar?: string };

/**
 * One model call; a content-filter refusal moves to a tolerant model, anything
 * else transient gets one more try. A reply cut off at the output limit is
 * continued. A reply that falls into repeating itself is cut back to before
 * the loop; if little is left, it is written again, a little warmer, and the
 * longer clean one is kept.
 */
async function callModel(args: CallArgs): Promise<string> {
  const first = await callContinued(args);
  // What is left once the loop is cut is usually a whole section; only a stub is worth writing again.
  if (!first.looped || first.text.length >= 6_000) return first.text;
  console.warn(`[SourceDigest] ${args.model} looped (${first.text.length} chars kept) — writing it again`);
  const second = await callContinued({ ...args, temperature: 0.6 });
  return (!second.looped || second.text.length > first.text.length ? second : first).text;
}

async function callContinued(args: CallArgs): Promise<{ text: string; looped: boolean }> {
  let text = "";
  for (let round = 0; ; round++) {
    const piece = await callWithRetry({ ...args, soFar: round > 0 ? text : undefined });
    const joined = text + piece.text;
    text = trimRepeats(joined);
    if (text.length < joined.length * 0.9) return { text: text.trim(), looped: true };
    if (!piece.truncated || round >= (args.continuations ?? 0)) break;
  }
  return { text: text.trim(), looped: false };
}

async function callWithRetry(args: OnceArgs): Promise<{ text: string; truncated: boolean }> {
  let truncated = false;
  const attempt = (model: string) => generateWithSummaryFallback({
    model, fallbackModel: DIGEST_REFUSAL_FALLBACK_MODEL,
    onFallback: (reason) => console.warn(`[SourceDigest] ${model} refused (${reason}) — retrying on ${DIGEST_REFUSAL_FALLBACK_MODEL}`),
    generate: async (m) => { const r = await callModelOnce({ ...args, model: m }); truncated = r.truncated; return r.text; },
  }).then((r) => ({ text: r.text, truncated }));
  try {
    return await attempt(args.model);
  } catch (error) {
    if (error instanceof DigestStopped || args.signal?.aborted) throw error;
    console.warn(`[SourceDigest] ${args.model} failed, retrying once:`, error instanceof Error ? error.message : error);
    return attempt(args.model);
  }
}

async function callModelOnce(args: OnceArgs): Promise<{ text: string; truncated: boolean }> {
  args.signal?.throwIfAborted();
  const model = applyModelRedirect(args.model);
  const resolved = await resolveProviderForModel(args.userId, model, { allowOfficialFallback: false });
  if (!resolved) throw new DigestStopped(`No API key is available for ${model}. Add one in Settings, or switch to official models.`);
  const messages: ChatMessage[] = [{ role: "system", content: args.system }, { role: "user", content: args.user }];
  if (args.soFar) messages.push({ role: "assistant", content: args.soFar }, { role: "user", content: "Continue exactly where you stopped. Do not repeat anything already written." });
  let text = "";
  let truncated = false;
  let observation = usageObservation();
  let promptTokens = 0; let completionTokens = 0; let totalTokens = 0;
  const start = Date.now();
  // Some upstreams ignore max_tokens (one wrote 393k tokens of a loop over 22
  // minutes). Past the limit, or past CALL_MAX_MS, the call is cut here and
  // treated like any reply cut off at the limit.
  const cut = new AbortController();
  const stop = args.signal ? AbortSignal.any([args.signal, cut.signal]) : cut.signal;
  const timer = setTimeout(() => cut.abort(), CALL_MAX_MS);
  try {
    for await (const chunk of resolved.provider.generateStream({
      signal: stop, model, messages, maxTokens: args.maxTokens, temperature: args.temperature ?? 0.2, disableReasoning: true,
    })) {
      if (chunk.type === "text") {
        text += chunk.content;
        if (approxTokens(text) > args.maxTokens * 1.2) { truncated = true; cut.abort(); break; }
      }
      if (chunk.usage) {
        observation = usageObservation(chunk.usage);
        promptTokens = chunk.usage.promptTokens; completionTokens = chunk.usage.completionTokens; totalTokens = chunk.usage.totalTokens;
      }
      if (chunk.type === "error") throw new Error(chunk.content || "The model call failed");
      if (chunk.type === "done" && chunk.stopReason === "max_tokens") truncated = true;
    }
  } catch (error) {
    if (!cut.signal.aborted || args.signal?.aborted) throw error;
    truncated = true;
  } finally {
    clearTimeout(timer);
  }
  if (cut.signal.aborted && totalTokens === 0) {
    // Cut before the provider reported usage: record (and bill) what was sent and received.
    promptTokens = approxTokens(messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(""));
    completionTokens = approxTokens(text);
    totalTokens = promptTokens + completionTokens;
  }
  if (totalTokens > 0) {
    const usageLogId = randomUUID();
    await recordUsageLog({
      ...observation, id: usageLogId, userId: args.userId, sessionId: null, model, promptTokens, completionTokens,
      totalTokens, endpoint: DIGEST_ENDPOINT, apiKeyTier: resolved.apiKeyTier, generationTimeMs: Date.now() - start,
    });
    if (!resolved.isByok) {
      try {
        // The provider's own charge when it reports one: the price table can lag a cheap model's real price.
        const providerCostUsd = observation.providerCostUsd === null ? undefined : Number(observation.providerCostUsd);
        await billBackgroundUsage({ userId: args.userId, model, promptTokens, completionTokens, usageLogId, endpoint: DIGEST_ENDPOINT, providerCostUsd });
      } catch (error) {
        if (error instanceof Error && /INSUFFICIENT_CREDITS|not enough/i.test(error.message)) throw new DigestStopped(notEnoughMushiesMessage(DIGEST_ENDPOINT));
        throw error;
      }
    }
  }
  if (!text.trim() && !args.soFar) throw new Error(`${model} returned an empty reply`);
  return { text: args.soFar ? text : text.trim(), truncated };
}

/**
 * Cuts a reply back where it fell into repeating itself: a phrase over and over
 * in place, or a line it already wrote (right after, or hundreds of lines
 * later — a long reply loops through the same few lines). Short repeats
 * (「啊啊啊」), headings and table rules are left alone.
 */
export function trimRepeats(text: string): string {
  const inPlace = text.replace(/([\s\S]{6,80}?)\1{5,}/g, "$1");
  return uniqueLines(inPlace.split("\n")).join("\n");
}

/** Drops a line that already appeared (any line straight after itself; elsewhere, unless it is short, a heading or a table rule). */
export function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    const free = key.length < 12 || key.startsWith("#") || /^\|?[\s:|-]+\|?$/.test(key);
    const again = key !== "" && kept.length > 0 && kept[kept.length - 1]!.trim() === key && !key.startsWith("#") && !/^\|?[\s:|-]+\|?$/.test(key);
    if ((!free && seen.has(key)) || again) continue;
    seen.add(key);
    kept.push(line);
  }
  return kept;
}

/** A merged section under the heading the code gives it, the model's own headings one level down. */
export function asSection(title: string, out: string): string {
  const lines = out.trim().split("\n");
  if (/^#{1,2}\s/.test(lines[0] ?? "")) lines.shift();
  const demote = lines.some((l) => /^##\s/.test(l));
  const body = lines.map((l) => (demote && /^#{2,5}\s/.test(l) ? `#${l}` : l)).join("\n").trim();
  return `## ${title}\n\n${body}`;
}

/** Runs `work` over items, `limit` at a time, stopping early on DigestStopped. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let stop: unknown = null;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !stop) {
      const i = next++;
      try { out[i] = await work(items[i]!); } catch (error) { stop = error; }
    }
  }));
  if (stop) throw stop;
  return out;
}

// ── Prompts ────────────────────────────────────────────────────────────────

const NOTE_SYSTEM = `You are reading one part of a long novel to build a canon reference for writing a fan-work. Write notes in the SAME LANGUAGE as the text. Only write what is in this part — never add anything from your own memory of the work; names exactly as this text writes them, in its own script — the standard name is the form the text uses most; never translate, romanize or complete a name from memory; other spellings that appear in the text go in aliases. Quotes must be copied character for character from the text, each at most 120 characters. Be concrete (numbers, names, places); no evaluative filler. 4000–7000 characters in total.

Use exactly these section headings, in this order:
## PLOT
### <chapter title>
3–6 sentences per chapter: what happens, who is there, where and when, the result.
## PEOPLE
- **<standard name>** | aliases: … | race/affiliation/role | level, abilities, skills, magic, equipment as they change here (names and numbers) | key actions here | relationship changes | how they speak (self-reference, how they address others, verbal habits) + one quote in 「」
## FACTIONS
- name | leader/god | core members | what they do here
## PLACES
- name | what it is like | what happens there here
## TERMS
- term | one-line definition (rules, systems, monsters, items) | chapter
## TIMELINE
- explicit time markers (day N, month, "two weeks later", someone's level-up)
## RELATIONS
- A → B: from … to … (chapter)
## QUOTES
> verbatim quote (≤120 chars) —— speaker, chapter
(2–4 of the most memorable lines)
## DOUBTS
- inconsistent names, contradictions, things unclear in this part`;

const SECTION_RULES = `You are merging reading notes about one novel into one section of a canon reference used to write a fan-work card. Write in the same language as the notes. Rules: use only what is in the material — never your own memory of the work; write names exactly as the 'Names as the book writes them' list gives them — never translate, romanize or lengthen a name — and other spellings only as aliases; after each fact give its source part as [P12] or [P12,14]; quotes only if they appear in the material WITHOUT a 〔未核实〕 mark; say in which part each secret or identity is revealed (spoiler points), so an author knows what a character can know at a given point; be concrete; where the material disagrees, say so in a line starting with "存疑：" listing both versions and their parts. Every heading and label is in the language of the notes, never English. Output only the section, in Markdown, starting with a level-2 heading.`;

function partLabel(p: DigestPart) {
  return `P${String(p.index).padStart(2, "0")}`;
}

// ── Quote check ────────────────────────────────────────────────────────────

const normQuote = (s: string) => s
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  .replace(/…/g, "...").replace(/[—–]/g, "-")
  .replace(/[“”"「」『』《》〈〉‘’'\s　]/g, "");

/** Marks every quote in the notes that is not in `haystack` (block quotes and
 *  「…」 of 10+ characters). Returns the notes and how many were checked/missed. */
export function checkQuotes(notes: string, haystack: string): { notes: string; checked: number; missing: number } {
  const hay = normQuote(haystack);
  let checked = 0; let missing = 0;
  const lines = notes.split("\n").map((line) => {
    const block = line.match(/^(\s*>\s*)(.+?)(\s*(?:——|--|—).{0,60})?$/);
    if (block && !line.includes("〔未核实〕")) {
      const q = block[2]!.trim().replace(/^[「“"]|[」”"]$/g, "");
      if (normQuote(q).length >= 6) {
        checked++;
        if (!hay.includes(normQuote(q))) { missing++; return `${line} 〔未核实〕`; }
      }
      return line;
    }
    return line.replace(/「([^「」\n]{10,140})」(?!\s*〔)/g, (whole, q: string) => {
      checked++;
      if (hay.includes(normQuote(q))) return whole;
      missing++;
      return `${whole}〔未核实〕`;
    });
  });
  return { notes: lines.join("\n"), checked, missing };
}

// ── Regroup by topic ───────────────────────────────────────────────────────

export interface Grouped {
  plot: string[]; factions: string[]; places: string[]; terms: string[]; timeline: string[];
  relations: string[]; quotes: string[]; doubts: string[];
  people: Map<string, string[]>;
}

const SECTION_KEYS: Record<string, keyof Omit<Grouped, "people"> | "people"> = {
  PLOT: "plot", PEOPLE: "people", FACTIONS: "factions", PLACES: "places", TERMS: "terms",
  TIMELINE: "timeline", RELATIONS: "relations", QUOTES: "quotes", DOUBTS: "doubts",
};

/** One person under all the ways the notes write them: the given name before
 *  a middle dot, without parentheses. */
export function personKey(raw: string): string {
  const name = raw.replace(/[（(].*?[）)]/g, "").split(/[／/｜|]/)[0]!.trim();
  return (name.split(/[·•・‧]/)[0] ?? name).trim();
}

/** Every name a PEOPLE line gives one person: the bold name, then its aliases. */
export function personNames(line: string): string[] {
  const bold = line.match(/^\s*[-*]\s*\*\*([^*]+)\*\*/)?.[1];
  if (!bold) return [];
  const aliases = line.match(/(?:aliases|别称|別稱|别名)\s*[:：]\s*([^|｜]*)/i)?.[1] ?? "";
  return [bold, ...aliases.split(/[、,，;；/／]/)].map((n) => n.replace(/[（(].*?[）)]/g, "").trim()).filter((n) => n && n !== "…" && n !== "-");
}

/**
 * Keys a person by the spelling the book itself uses most. Readers sometimes
 * write a name from memory (romanized, or a full name the translation never
 * uses); the book is the authority, so the most frequent form in it wins and
 * every other spelling folds into it.
 *
 * Given the notes too, spellings are linked across entries first: a part that
 * writes 「莉莉露卡」 with alias 「莉莉」 joins another part's 「莉莉」 entry. An
 * alias several different people claim (a title like 「女神」) links nothing.
 */
export function bookSpelling(text: string, notes: string[] = []): (names: string[]) => string | null {
  const counts = new Map<string, number>();
  const count = (n: string) => {
    let c = counts.get(n);
    if (c === undefined) {
      c = 0;
      if (n.length >= 2) for (let at = text.indexOf(n); at >= 0 && c < 5000; at = text.indexOf(n, at + n.length)) c++;
      counts.set(n, c);
    }
    return c;
  };
  const entries = notes.flatMap((n) => n.split("\n")).map((l) => personNames(l).map(personKey).filter((k) => count(k) > 0)).filter((k) => k.length);
  const claimedBy = new Map<string, Set<string>>();
  for (const keys of entries) for (const k of keys) { const s = claimedBy.get(k) ?? new Set(); s.add(keys[0]!); claimedBy.set(k, s); }
  // Ambiguous: more than one other person (besides an entry under this very name) claims it.
  const ambiguous = (k: string) => [...(claimedBy.get(k) ?? [])].filter((h) => h !== k).length > 1;
  const parent = new Map<string, string>();
  const find = (k: string): string => { const p = parent.get(k); if (!p || p === k) return k; const r = find(p); parent.set(k, r); return r; };
  for (const keys of entries) {
    const head = keys[0]!;
    for (const k of keys.slice(1)) if (!ambiguous(k)) {
      const a = find(head); const b = find(k); if (a !== b) parent.set(a, b);
    }
  }
  const members = new Map<string, string[]>();
  for (const k of claimedBy.keys()) { const r = find(k); members.set(r, [...(members.get(r) ?? []), k]); }
  return (names) => {
    let best: string | null = null; let most = 0;
    const keys = names.map(personKey).filter((k, i) => i === 0 || !ambiguous(k));
    const linked = keys.flatMap((k) => (claimedBy.has(k) ? members.get(find(k)) ?? [k] : [k]));
    for (const key of new Set([...keys, ...linked])) { const c = count(key); if (c > most) { best = key; most = c; } }
    return best;
  };
}

export function groupNotes(notes: Array<{ part: DigestPart; text: string }>, canon?: (names: string[]) => string | null): Grouped {
  const g: Grouped = { plot: [], factions: [], places: [], terms: [], timeline: [], relations: [], quotes: [], doubts: [], people: new Map() };
  for (const { part, text } of notes) {
    const label = partLabel(part);
    let key: string | null = null;
    let person: string | null = null;
    for (const line of text.split("\n")) {
      const head = line.match(/^##\s+([A-Z]+)/);
      if (head) {
        key = SECTION_KEYS[head[1]!] ?? null; person = null;
        if (key && key !== "people") (g[key as keyof Omit<Grouped, "people">] as string[]).push(`\n### [${label}] ${part.first} → ${part.last}`);
        continue;
      }
      if (!key || !line.trim()) continue;
      if (key === "people") {
        const m = line.match(/^\s*[-*]\s*\*\*([^*]+)\*\*/);
        if (m) {
          person = canon?.(personNames(line)) ?? personKey(m[1]!);
          if (!person) continue;
          const list = g.people.get(person) ?? [];
          list.push(`[${label}] ${line.trim()}`);
          g.people.set(person, list);
        } else if (person) {
          g.people.get(person)!.push(`  ${line.trim()}`);
        }
        continue;
      }
      (g[key as keyof Omit<Grouped, "people">] as string[]).push(line);
    }
  }
  return g;
}

/** People by how many parts mention them, most first. */
export function rankPeople(people: Map<string, string[]>): Array<{ name: string; lines: string[]; parts: number }> {
  return [...people.entries()]
    .map(([name, lines]) => ({ name, lines, parts: lines.filter((l) => l.startsWith("[P")).length }))
    .sort((a, b) => b.parts - a.parts || b.lines.join("").length - a.lines.join("").length);
}

/** Splits text into groups no bigger than `max` characters, at line breaks. */
function slices(lines: string[], max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur && cur.length + line.length > max) { out.push(cur); cur = ""; }
    cur += `${line}\n`;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ── Storage of working files ───────────────────────────────────────────────

async function readStored(key: string): Promise<string | null> {
  try { return (await getObjectBuffer(key, { maxBytes: 4_000_000 })).buffer.toString("utf8"); } catch { return null; }
}
const store = (key: string, text: string) => putObject(key, Buffer.from(text, "utf8"), "text/markdown; charset=utf-8");

// ── The digest ─────────────────────────────────────────────────────────────

export interface DigestProgress { phase: "read" | "merge" | "check" | "save"; done: number; total: number; label: string }

export interface DigestResult {
  bible: { id: string; name: string; chars: number };
  parts: number; quotesChecked: number; quotesMissing: number; sections: number; questionsSettled: number;
  /** First and last chapter read, and the section headings: what the assistant tells the creator it covers. */
  covers: { first: string; last: string; sections: string[] };
}

/** Where a digest stands, kept beside its notes so a reloaded page (or another device) can show it. */
export interface DigestStatus extends DigestProgress { updatedAt: string; finished?: boolean; error?: string }

const statusKey = (userId: string, worldId: string, id: string) => `${sourceDigestPrefix(userId, worldId, id)}status.json`;

export async function readDigestStatus(userId: string, worldId: string, id: string): Promise<DigestStatus | null> {
  const raw = await readStored(statusKey(userId, worldId, id));
  try { return raw ? JSON.parse(raw) as DigestStatus : null; } catch { return null; }
}

type DigestArgs = {
  userId: string; worldId: string; sourceId: string; signal?: AbortSignal;
  onProgress?: (p: DigestProgress) => void | Promise<void>;
};

export async function digestSource(args: DigestArgs): Promise<DigestResult> {
  const meta = (await listSources(args.userId, args.worldId)).find((s) => s.id === args.sourceId || s.name === args.sourceId);
  if (!meta) throw new DigestStopped(`No source ${args.sourceId} on this card.`);
  const key = statusKey(args.userId, args.worldId, meta.id);
  // One write at a time, in order, so a late heartbeat never lands on top of "finished".
  let writing: Promise<void> = Promise.resolve();
  const write = (s: Omit<DigestStatus, "updatedAt">) => (writing = writing.then(() =>
    putObject(key, Buffer.from(JSON.stringify({ ...s, updatedAt: new Date().toISOString() }), "utf8"), "application/json").catch(() => {})));
  let last: DigestProgress = { phase: "read", done: 0, total: 0, label: "" };
  // One section can take many minutes without a new count; the status still says it is alive.
  const beat = setInterval(() => void write(last), 60_000);
  try {
    const result = await digestBook({ ...args, onProgress: async (p) => { last = p; await write(p); await args.onProgress?.(p); } }, meta);
    clearInterval(beat);
    await write({ ...last, finished: true });
    return result;
  } catch (error) {
    clearInterval(beat);
    await write({ ...last, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearInterval(beat);
  }
}

type RunningDigest = {
  controller: AbortController;
  promise: Promise<DigestResult>;
  listeners: Set<(p: DigestProgress) => void | Promise<void>>;
  /** Agent runs that asked for it; stopping one of them stops the digest. */
  runIds: Set<string>;
};
const running = new Map<string, RunningDigest>();
const runningKey = (userId: string, worldId: string, sourceId: string) => `${userId}/${worldId}/${sourceId}`;

/**
 * Starts the digest of one book, or joins the one already running. It belongs
 * to the card, not to the chat turn that asked for it: a reload, or a new
 * message that supersedes that turn, only stops the turn from watching. The
 * creator stops it with Stop on the turn that started it, or by removing the
 * book.
 */
export function runDigest(args: {
  userId: string; worldId: string; sourceId: string; runId: string;
  onProgress?: (p: DigestProgress) => void | Promise<void>;
}): { promise: Promise<DigestResult>; detach: () => void } {
  const key = runningKey(args.userId, args.worldId, args.sourceId);
  let job = running.get(key);
  if (!job) {
    const controller = new AbortController();
    const listeners: RunningDigest["listeners"] = new Set();
    const promise = digestSource({
      userId: args.userId, worldId: args.worldId, sourceId: args.sourceId, signal: controller.signal,
      onProgress: async (p) => { for (const listen of listeners) await Promise.resolve(listen(p)).catch(() => {}); },
    }).finally(() => running.delete(key));
    promise.catch(() => {}); // nobody may be watching when it fails
    job = { controller, promise, listeners, runIds: new Set() };
    running.set(key, job);
  }
  const joined = job;
  joined.runIds.add(args.runId);
  if (args.onProgress) joined.listeners.add(args.onProgress);
  return { promise: joined.promise, detach: () => { if (args.onProgress) joined.listeners.delete(args.onProgress); } };
}

/** Stops the digests an agent run started, or the one reading a given book. */
export function stopDigests(match: { runId: string } | { userId: string; worldId: string; sourceId: string }) {
  for (const [key, job] of running) {
    const hit = "runId" in match ? job.runIds.has(match.runId) : key === runningKey(match.userId, match.worldId, match.sourceId);
    if (hit) job.controller.abort();
  }
}

async function digestBook(args: DigestArgs, meta: SourceMeta): Promise<DigestResult> {
  const { userId, worldId, signal } = args;
  const progress = async (p: DigestProgress) => { await args.onProgress?.(p); };
  if (meta.name.endsWith(BIBLE_SUFFIX)) throw new DigestStopped("That is already a digest. Digest the book itself.");
  const reader = await resolveProviderForModel(userId, applyModelRedirect(DIGEST_READER_MODEL), { allowOfficialFallback: false });
  if (reader && !reader.isByok && !(await hasBackgroundRunBudget(userId))) throw new DigestStopped(notEnoughMushiesMessage(DIGEST_ENDPOINT));

  const text = await loadSourceText(userId, worldId, meta.id);
  const parts = planParts(meta);
  const dir = sourceDigestPrefix(userId, worldId, meta.id);
  let done = 0;
  let quotesChecked = 0; let quotesMissing = 0;

  // 1–3. Read every part (reusing notes a stopped run already paid for).
  await progress({ phase: "read", done, total: parts.length, label: "" });
  const notes = await pool(parts, CONCURRENCY, async (part) => {
    signal?.throwIfAborted();
    const key = `${dir}notes-${String(part.index).padStart(3, "0")}.md`;
    let note = await readStored(key);
    if (!note) {
      const body = text.slice(part.start, part.end);
      const raw = await callModel({
        userId, signal, model: DIGEST_READER_MODEL, maxTokens: NOTE_MAX_TOKENS, system: NOTE_SYSTEM,
        user: `Part ${partLabel(part)} of 「${meta.name}」 (${part.first} → ${part.last}):\n\n${body}`,
      });
      const near = text.slice(Math.max(0, part.start - 20_000), Math.min(text.length, part.end + 20_000));
      const checked = checkQuotes(raw, near);
      note = checked.notes;
      await store(key, note);
    }
    const counted = checkQuotes(note, text.slice(Math.max(0, part.start - 20_000), Math.min(text.length, part.end + 20_000)));
    quotesChecked += counted.checked; quotesMissing += (note.match(/〔未核实〕/g) ?? []).length;
    done++;
    await progress({ phase: "read", done, total: parts.length, label: part.first });
    return { part, text: note };
  });

  // 4. Regroup in code.
  const g = groupNotes(notes, bookSpelling(text, notes.map((n) => n.text)));
  // Many parts restate the same backstory; the merge only needs it once.
  for (const k of ["plot", "factions", "places", "terms", "timeline", "relations", "quotes"] as const) g[k] = uniqueLines(g[k]);
  const ranked = rankPeople(g.people).filter((p) => p.parts >= 2);
  const major = ranked.slice(0, 36);
  const minor = ranked.slice(36, 140);
  const spellings = rankPeople(g.people).slice(0, 80).map((p) => p.name).join("、");

  // 5. One call per section.
  type Job = { file: string; title: string; brief: string; material: string };
  const jobs: Job[] = [];
  // Each section is sized so the model can finish it: a section cut off at the
  // output limit loses its end, and the end of a book is where it matters most.
  const SLICE = 25_000;
  const add = (file: string, title: string, brief: string, lines: string[], size = SLICE) => {
    const parts = slices(lines, size);
    parts.forEach((material, i) => jobs.push({
      file: parts.length > 1 ? `${file}-${i + 1}` : file,
      title: parts.length > 1 ? `${title} ${i + 1}/${parts.length}` : title,
      brief, material,
    }));
  };
  add("plot", "剧情",
    "Plot section. One level-3 subsection per volume (卷) or side-story volume in the material, in reading order — never merge volumes. For each: a 400–800 character synopsis; 3–6 key turning points; an end-of-arc snapshot of where the main characters stand (level, affiliation, relationships, situation) and a suggested point a fan-work player could enter the story; secrets revealed. End with a timeline of this stretch. Cover every arc in the material, to its end.",
    // Plot notes are written chapter by chapter and the model expands them, so
    // a plot section gets less material than the others.
    g.plot, 15_000);
  for (let i = 0; i < major.length; i += 3) {
    const group = major.slice(i, i + 3);
    jobs.push({
      file: `people-${i / 3 + 1}`, title: `人物：${group.map((p) => p.name).join("、")}`,
      brief: "Character profiles, one per person (a level-3 heading each), most detail for the first. Each: aliases | race/affiliation | first appearance; appearance; abilities as they change by part (levels, skills, magic, numbers); personality and motives; how they speak (self-reference, how they address others, habits) with 1–3 quotes; key relationships and how they change; history by part, 1–2 sentences each; spoiler points; what fan-work writers get wrong (only when the material shows something easy to get wrong — otherwise leave the field out). At most 6000 characters per person.",
      material: (group.map((p) => `# ${p.name}\n${p.lines.join("\n")}`).join("\n\n")).slice(0, 90_000),
    });
  }
  if (minor.length) add("people-minor", "其他人物",
    "A table of minor characters, one line each: name | who they are | one sentence | parts.",
    minor.map((p) => `# ${p.name}\n${p.lines.slice(0, 6).join("\n")}`), 60_000);
  add("factions", "势力",
    "Factions and organisations: each with leader/god, core members, base, standing, relations with others, what it does by part. Then the institutional rules of this world that appear here (joining, leaving, what gods may not do, contests…).",
    g.factions);
  add("relations", "关系网", "A relationship web: A → B: relation and how it changes, with parts. Group by person.", g.relations);
  add("places", "地点", "Places, with what happened there (by part); regions/levels of any special locations; places beyond the main setting.", g.places);
  add("terms", "术语", "A glossary of terms and systems, one line each (at most 120 characters) with its rules and numbers.", g.terms);
  add("timeline", "时间线", "A timeline aligned to the time markers, in story order.", g.timeline);
  const samples = [0.02, 0.5, 0.9].map((at) => text.slice(Math.floor(text.length * at), Math.floor(text.length * at) + 6_000));
  jobs.push({
    file: "style", title: "文风",
    brief: "A style guide for writing in this work's voice: narrative person/viewpoint; typography conventions (brackets, names of skills, onomatopoeia) with examples copied from the samples; how combat, daily life and inner thoughts are written; a voice table per main character; 20–30 memorable quotes (only ones without 〔未核实〕) with speaker and part; 8–10 concrete instructions for an AI writing in this style.",
    material: `# Quotes from the notes\n${g.quotes.join("\n").slice(0, 40_000)}\n\n# Samples of the text\n${samples.map((s, i) => `## Sample ${i + 1}\n${s}`).join("\n\n")}`,
  });

  let merged = 0;
  await progress({ phase: "merge", done: 0, total: jobs.length, label: "" });
  const sections = await pool(jobs, MERGE_CONCURRENCY, async (job) => {
    const key = `${dir}section-v6-${job.file}.md`;
    let out = await readStored(key);
    if (!out) {
      out = await callModel({
        userId, signal, model: DIGEST_MERGE_MODEL, maxTokens: SECTION_MAX_TOKENS, system: SECTION_RULES,
        user: `Section to write: ${job.title}\n${job.brief}\n\nNames as the book writes them: ${spellings}\n\nMaterial:\n${job.material}`,
        continuations: 1,
      });
      out = asSection(job.title, out);
      await store(key, out);
    }
    merged++;
    await progress({ phase: "merge", done: merged, total: jobs.length, label: job.title });
    return { ...job, out };
  });

  // 6. Settle each section's open questions against the book.
  let checkedSections = 0;
  let settled = 0;
  await progress({ phase: "check", done: 0, total: sections.length, label: "" });
  const final = await pool(sections, MERGE_CONCURRENCY, async (section) => {
    const key = `${dir}checked-v6-${section.file}.md`;
    let out = await readStored(key);
    if (!out) {
      out = section.out;
      const doubts = out.split("\n").filter((l) => /存疑|矛盾|不一致|〔未核实〕/.test(l)).slice(0, 14);
      if (doubts.length) {
        const ask = await callModel({
          userId, signal, model: DIGEST_MERGE_MODEL, maxTokens: 2_000,
          system: "For each open question below, give up to 3 short literal search strings (names, terms, exact phrases from the book) that would find the passage that settles it. Answer JSON only: [{\"q\":1,\"search\":[\"…\"]}].",
          user: doubts.map((d, i) => `${i + 1}. ${d}`).join("\n"),
        });
        const wanted = parseSearches(ask);
        const evidence: string[] = [];
        for (const { q, search } of wanted) {
          for (const term of search.slice(0, 3)) {
            const hits: SourceHit[] = [];
            searchText(meta, text, term.split(/\s+/).filter(Boolean), { max: 3, around: 220 }, hits);
            for (const h of hits) evidence.push(`[Q${q}] 「${term}」 ${h.chapter_title}: ${h.snippet}`);
          }
        }
        if (evidence.length) {
          // Only the open lines are rewritten, by the code: asking for the whole
          // section back is slow, costly, and can drop half of it.
          const reply = await callModel({
            userId, signal, model: DIGEST_MERGE_MODEL, maxTokens: 4_000,
            system: `${SECTION_RULES}\nYou are settling open questions in a section you wrote, from excerpts of the book. For each question give the line that replaces it: the correct fact with its part reference if the excerpts decide it; "原文前后不一致：A / B，建议用 A" with the reason if the book itself is inconsistent; for a 〔未核实〕 quote, the exact wording from an excerpt or a paraphrase. If the excerpts do not settle it, keep the line as it is. Answer JSON only: [{"q":1,"line":"…","note":"one short conclusion"}].`,
            user: `Open questions:\n${doubts.map((d, i) => `Q${i + 1}. ${d}`).join("\n")}\n\nExcerpts from the book:\n${evidence.join("\n").slice(0, 60_000)}`,
          });
          const fixed = applyCorrections(out, doubts, parseCorrections(reply));
          out = fixed.text;
          settled += fixed.settled;
        }
      }
      await store(key, out);
    }
    checkedSections++;
    await progress({ phase: "check", done: checkedSections, total: sections.length, label: section.title });
    return out;
  });

  // 7. Store the reference with the card, replacing an older one.
  await progress({ phase: "save", done: 0, total: 1, label: "" });
  const name = `${meta.name.replace(/\.(txt|md)$/i, "")}${BIBLE_SUFFIX}`;
  const header = [
    `# ${meta.name} · 原著资料库`,
    "",
    `由 ${parts.length} 段并行阅读的笔记合并而成；每条事实后面的 [Pnn] 是出处段号，段号对应的章节见文末。原文引用逐字核对过（共 ${quotesChecked} 处，${quotesMissing} 处对不上已标〔未核实〕，不要当原文引用）。资料库里的「存疑」已拿回原文查过，查不清的保留两种说法。细节以原文为准：用 search_source / read_source 查「${meta.name}」。`,
  ].join("\n");
  const index = ["## 段号对照", "", "| 段 | 起 | 止 |", "|---|---|---|", ...parts.map((p) => `| ${partLabel(p)} | ${p.first} | ${p.last} |`)].join("\n");
  const bibleText = [header, ...final, index].join("\n\n");
  const current = await listSources(userId, worldId);
  if (!current.some((s) => s.id === meta.id)) throw new DigestStopped("The book was removed from the card.");
  const old = current.find((s) => s.name === name);
  if (old) await removeSource(userId, worldId, old.id);
  const saved = await addSource(userId, worldId, name, new TextEncoder().encode(bibleText));
  await progress({ phase: "save", done: 1, total: 1, label: name });
  return {
    bible: { id: saved.id, name: saved.name, chars: saved.chars },
    parts: parts.length, quotesChecked, quotesMissing, sections: final.length, questionsSettled: settled,
    covers: { first: parts[0]?.first ?? "", last: parts.at(-1)?.last ?? "", sections: sections.map((x) => x.title) },
  };
}

export function parseSearches(raw: string): Array<{ q: number; search: string[] }> {
  const json = raw.match(/\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const it = item as { q?: unknown; search?: unknown };
        const search = Array.isArray(it.search) ? it.search.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim().slice(0, 40)) : [];
        return { q: Number(it.q) || 0, search };
      })
      .filter((it) => it.search.length > 0)
      .slice(0, 14);
  } catch {
    return [];
  }
}

export function parseCorrections(raw: string): Array<{ q: number; line: string; note: string }> {
  const json = raw.match(/\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const it = (item ?? {}) as Record<string, unknown>;
        return { q: Number(it.q), line: typeof it.line === "string" ? it.line.trim() : "", note: typeof it.note === "string" ? it.note.trim() : "" };
      })
      .filter((c) => Number.isInteger(c.q) && c.q > 0 && c.line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Replaces each settled open line in the section with its correction (keeping
 * the line's list marker and indent) and records the outcome at the end.
 */
export function applyCorrections(section: string, doubts: string[], corrections: Array<{ q: number; line: string; note: string }>): { text: string; settled: number } {
  const lines = section.split("\n");
  const record: string[] = [];
  let settled = 0;
  for (const c of corrections) {
    const doubt = doubts[c.q - 1];
    if (doubt === undefined || c.line === doubt.trim()) continue;
    const at = lines.indexOf(doubt);
    if (at < 0) continue;
    const lead = doubt.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
    lines[at] = lead + c.line.replace(/^\s*(?:[-*]\s+|\d+\.\s+)?/, "");
    settled++;
    if (c.note) record.push(`- ${doubt.slice(lead.length).trim().slice(0, 60)} → ${c.note}`);
  }
  const text = lines.join("\n");
  return { text: record.length ? `${text}\n\n### 核对记录\n${record.join("\n")}` : text, settled };
}
