/**
 * Source texts for a card: the novel a fan-work is built from, kept beside
 * the card rather than in the conversation.
 *
 * A creator writing a 同人 card has the whole book, and the obvious move —
 * attach the txt — pasted every character of it into one chat message: a
 * novel of a few million characters either failed outright or was compacted
 * away on the next turn, and every turn that kept it paid for all of it again.
 * A card does not need the book in the prompt. It needs to look things up in
 * it: who said what, what a place is called in this translation, what happened
 * in chapter 40. So the text is stored once (object storage, per creator and
 * card), cut into chapters, and the assistant searches and reads slices of it
 * with tools (search_source / read_source).
 *
 * No table: a manifest object per card lists its sources, so adding this did
 * not need a schema change.
 */
import { deleteObject, deletePrefix, getObjectBuffer, putObject } from "./s3.js";

export interface SourceChapter {
  title: string;
  start: number;
  end: number;
}

export interface SourceMeta {
  id: string;
  name: string;
  chars: number;
  chapters: SourceChapter[];
  createdAt: string;
}

const MAX_SOURCES = 6;
/** Characters one read_source call returns at most. */
export const READ_MAX = 12_000;
/** A chapter longer than this is read in parts; it is also how a text with
 *  no headings at all gets its "chapters". */
const PART_MAX = 30_000;

const prefix = (userId: string, worldId: string) => `studio-sources/${userId}/${worldId}`;
/** Where the browser puts a file before the server turns it into a source. */
export const sourceIncomingPrefix = (userId: string, worldId: string) => `${prefix(userId, worldId)}/incoming/`;
const manifestKey = (userId: string, worldId: string) => `${prefix(userId, worldId)}/manifest.json`;
const textKey = (userId: string, worldId: string, id: string) => `${prefix(userId, worldId)}/${id}.txt`;
/** Where a source's digest keeps its working files (per-part notes), so a
 *  stopped digest picks up where it left off. */
export const sourceDigestPrefix = (userId: string, worldId: string, id: string) => `${prefix(userId, worldId)}/${id}.digest/`;

// ── Decoding ───────────────────────────────────────────────────────────────

/** UTF-8 when it is valid UTF-8, UTF-16 by its mark, otherwise GB18030 —
 *  which is what most Chinese web-novel txt files actually are. */
export function decodeSourceBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("gb18030").decode(bytes);
  }
  return normalizeSourceText(text);
}

export function normalizeSourceText(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    // Scraped txt keeps HTML numeric entities (&#12539; for ・).
    .replace(/&#(\d{2,6});/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t　]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

// ── Chapters ───────────────────────────────────────────────────────────────

const HEADING = /^(?:第[0-9一二三四五六七八九十百千零〇两]+[卷章回话節节幕集部篇]|序章|序幕|序曲|楔子|终章|終章|尾声|尾聲|后记|後記|番外|外传|外傳|间章|間章|插章|幕间|Chapter\s*\d+|CHAPTER\s*\d+|Prologue|Epilogue|Interlude)/;

/** Chapters by their headings; long ones (and a text with none) in parts. */
export function splitSourceChapters(text: string): SourceChapter[] {
  const heads: Array<{ title: string; at: number }> = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (s && s.length <= 60 && HEADING.test(s)) heads.push({ title: s, at });
    at += line.length + 1;
  }
  if (heads.length === 0 || heads[0]!.at > 0) heads.unshift({ title: "开头", at: 0 });
  const raw: SourceChapter[] = heads.map((h, i) => ({ title: h.title, start: h.at, end: heads[i + 1]?.at ?? text.length }))
    .filter((c) => c.end > c.start);
  const out: SourceChapter[] = [];
  for (const ch of raw) {
    if (ch.end - ch.start <= PART_MAX) { out.push(ch); continue; }
    let start = ch.start;
    let n = 1;
    while (start < ch.end) {
      let end = Math.min(ch.end, start + PART_MAX);
      if (end < ch.end) {
        const brk = text.lastIndexOf("\n", end);
        if (brk > start + PART_MAX / 2) end = brk + 1;
      }
      out.push({ title: n === 1 ? ch.title : `${ch.title}（${n}）`, start, end });
      start = end;
      n++;
    }
  }
  return out;
}

// ── Storage ────────────────────────────────────────────────────────────────

export async function listSources(userId: string, worldId: string): Promise<SourceMeta[]> {
  try {
    const { buffer } = await getObjectBuffer(manifestKey(userId, worldId), { maxBytes: 4_000_000 });
    const parsed = JSON.parse(buffer.toString("utf8")) as { sources?: SourceMeta[] };
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

async function writeManifest(userId: string, worldId: string, sources: SourceMeta[]) {
  await putObject(manifestKey(userId, worldId), Buffer.from(JSON.stringify({ sources })), "application/json");
}

export class SourceLimitError extends Error {}

export async function addSource(userId: string, worldId: string, name: string, bytes: Uint8Array): Promise<SourceMeta> {
  const existing = await listSources(userId, worldId);
  const text = decodeSourceBytes(bytes);
  const cleanName = name.trim().slice(0, 120) || "source.txt";
  // The same book attached again (a retried send, a second drag) is the one already kept.
  const same = existing.find((s) => s.name === cleanName && s.chars === text.length);
  if (same) return same;
  if (existing.length >= MAX_SOURCES) throw new SourceLimitError(`A card keeps at most ${MAX_SOURCES} source texts.`);
  const meta: SourceMeta = {
    id: `src_${crypto.randomUUID().slice(0, 8)}`,
    name: cleanName,
    chars: text.length,
    chapters: splitSourceChapters(text),
    createdAt: new Date().toISOString(),
  };
  await putObject(textKey(userId, worldId, meta.id), Buffer.from(text, "utf8"), "text/plain; charset=utf-8");
  await writeManifest(userId, worldId, [...existing, meta]);
  textCache.set(textKey(userId, worldId, meta.id), text);
  return meta;
}

export async function removeSource(userId: string, worldId: string, id: string): Promise<boolean> {
  const existing = await listSources(userId, worldId);
  if (!existing.some((s) => s.id === id)) return false;
  await writeManifest(userId, worldId, existing.filter((s) => s.id !== id));
  await deleteObject(textKey(userId, worldId, id)).catch(() => {});
  await deletePrefix(sourceDigestPrefix(userId, worldId, id)).catch(() => 0);
  textCache.delete(textKey(userId, worldId, id));
  return true;
}

/** A few recently read texts, so a run of searches does not refetch a 20MB
 *  object every call. */
const textCache = new Map<string, string>();
const CACHE_MAX = 4;

export async function loadSourceText(userId: string, worldId: string, id: string): Promise<string> {
  const key = textKey(userId, worldId, id);
  const hit = textCache.get(key);
  if (hit !== undefined) {
    textCache.delete(key);
    textCache.set(key, hit);
    return hit;
  }
  const { buffer } = await getObjectBuffer(key, { maxBytes: 80_000_000 });
  const text = buffer.toString("utf8");
  textCache.set(key, text);
  while (textCache.size > CACHE_MAX) textCache.delete(textCache.keys().next().value!);
  return text;
}

// ── What the assistant sees ────────────────────────────────────────────────

/** One line per source for the system prompt, so the assistant knows what it
 *  can look things up in without being handed any of it. */
export function describeSources(sources: SourceMeta[]): string {
  if (sources.length === 0) return "";
  const lines = sources.map((s) => `- ${s.id}「${s.name}」 ${s.chars.toLocaleString("en-US")} chars, ${s.chapters.length} chapters/parts (first: ${s.chapters[0]?.title ?? "-"}; last: ${s.chapters[s.chapters.length - 1]?.title ?? "-"})`);
  return [
    "",
    "## Source texts attached to this card",
    "The creator stored these with the card (not in the conversation). They are the canon this card is built from.",
    ...lines,
    ...(sources.some((s) => !s.name.endsWith("·原著资料库.md") && !sources.some((d) => d.name === `${s.name.replace(/\.(txt|md)$/i, "")}·原著资料库.md`))
      ? ["A book here has no digest (·原著资料库.md) yet. When the creator wants a card built from the book as a whole, offer digest_source first: it reads the whole book into a checked reference you can then work from."]
      : ["A source ending in ·原著资料库.md is the checked reference made from its book: read the parts you need from it first (list_chapters shows its sections), then search the book for details."]),
    "Use search_source to find where a name, term, place or line appears, and read_source to read a chapter (or a slice of one). For anything canon-specific — names as this translation writes them, who said what, what a place or skill is, the order of events — look it up rather than relying on your own memory of the work; your memory may follow a different translation or be wrong. Quote sparingly: use the source to get facts and voice right, and write the card's text yourself.",
  ].join("\n");
}

function resolveSource(sources: SourceMeta[], id: unknown): SourceMeta | null {
  if (typeof id === "string" && id) return sources.find((s) => s.id === id || s.name === id) ?? null;
  return sources.length === 1 ? sources[0]! : null;
}

const chapterAt = (meta: SourceMeta, offset: number) =>
  meta.chapters.findIndex((c) => offset >= c.start && offset < c.end);

export interface SourceHit { source_id: string; chapter: number; chapter_title: string; offset: number; snippet: string }

/** The search itself, over text already in hand. */
export function searchText(meta: SourceMeta, text: string, terms: string[], opts: { max: number; around: number }, hits: SourceHit[]): number {
  // Space-separated words must all appear within one window around the
  // first word's match — "贝尔 艾丝 告白" finds the scene, not three chapters.
  const window = 300;
  let total = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(terms[0]!, from);
    if (at < 0) break;
    from = at + terms[0]!.length;
    if (terms.length > 1) {
      const span = text.slice(Math.max(0, at - window), at + window);
      if (!terms.slice(1).every((t) => span.includes(t))) continue;
    }
    total++;
    if (hits.length >= opts.max) continue;
    const ci = chapterAt(meta, at);
    hits.push({
      source_id: meta.id,
      chapter: ci,
      chapter_title: meta.chapters[ci]?.title ?? "",
      offset: at,
      snippet: text.slice(Math.max(0, at - opts.around), at + terms[0]!.length + opts.around).replace(/\n+/g, " ⏎ "),
    });
  }
  return total;
}

export async function searchSource(userId: string, worldId: string, args: {
  source_id?: unknown; query?: unknown; max_results?: unknown; context_chars?: unknown;
}) {
  const sources = await listSources(userId, worldId);
  if (sources.length === 0) return { error: "This card has no source texts. The creator can attach a large .txt in the assistant panel." };
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { error: "query is required" };
  const targets = typeof args.source_id === "string" && args.source_id ? [resolveSource(sources, args.source_id)].filter(Boolean) as SourceMeta[] : sources;
  if (targets.length === 0) return { error: `Unknown source_id. Sources: ${sources.map((s) => s.id).join(", ")}` };
  const max = Math.min(40, Math.max(1, Number(args.max_results) || 15));
  const around = Math.min(400, Math.max(40, Number(args.context_chars) || 120));
  const terms = query.split(/\s+/).filter(Boolean);
  const hits: SourceHit[] = [];
  let total = 0;
  for (const meta of targets) total += searchText(meta, await loadSourceText(userId, worldId, meta.id), terms, { max, around }, hits);
  return {
    query, total_matches: total, shown: hits.length,
    ...(total > hits.length ? { note: "More matches than shown. Add a second word to narrow it, or read_source a chapter listed here." } : {}),
    hits,
  };
}

export async function readSource(userId: string, worldId: string, args: ReadArgs) {
  const sources = await listSources(userId, worldId);
  if (sources.length === 0) return { error: "This card has no source texts." };
  const meta = resolveSource(sources, args.source_id);
  if (!meta) return { error: `Pass source_id. Sources: ${sources.map((s) => `${s.id}「${s.name}」`).join(", ")}` };
  if (args.list_chapters === true) return listChapters(meta, args);
  return readText(meta, await loadSourceText(userId, worldId, meta.id), args);
}

export interface ReadArgs { source_id?: unknown; chapter?: unknown; offset?: unknown; length?: unknown; list_chapters?: unknown }

export function listChapters(meta: SourceMeta, args: ReadArgs) {
  const from = Math.max(0, Number(args.offset) || 0);
  const slice = meta.chapters.slice(from, from + 300);
  return {
    source_id: meta.id, name: meta.name, chapters_total: meta.chapters.length,
    chapters: slice.map((c, i) => ({ chapter: from + i, title: c.title, chars: c.end - c.start })),
    ...(from + slice.length < meta.chapters.length ? { next: `list_chapters with offset ${from + slice.length}` } : {}),
  };
}

/** A slice of text already in hand: by chapter (offset within it) or by
 *  absolute offset. */
export function readText(meta: SourceMeta, text: string, args: ReadArgs) {
  const length = Math.min(READ_MAX, Math.max(500, Number(args.length) || READ_MAX));
  let start: number;
  let end: number;
  if (args.chapter !== undefined && args.chapter !== null && args.chapter !== "") {
    const idx = typeof args.chapter === "number" ? args.chapter
      : /^\d+$/.test(String(args.chapter)) ? Number(args.chapter)
      : meta.chapters.findIndex((c) => c.title.includes(String(args.chapter)));
    const ch = meta.chapters[idx];
    if (!ch) return { error: `No chapter ${String(args.chapter)}. Use list_chapters:true to see them (0–${meta.chapters.length - 1}).` };
    // offset is relative to the chapter here, to page through a long one.
    start = Math.min(ch.end, ch.start + Math.max(0, Number(args.offset) || 0));
    end = Math.min(ch.end, start + length);
  } else {
    start = Math.min(text.length, Math.max(0, Number(args.offset) || 0));
    end = Math.min(text.length, start + length);
  }
  const ci = chapterAt(meta, start);
  const ch = meta.chapters[ci];
  return {
    source_id: meta.id,
    chapter: ci,
    chapter_title: ch?.title ?? "",
    offset: start,
    text: text.slice(start, end),
    ...(ch && end < ch.end ? { more_in_chapter: `read_source chapter ${ci} offset ${end - ch.start}` } : {}),
    ...(ch && end >= ch.end && ci + 1 < meta.chapters.length ? { next_chapter: ci + 1 } : {}),
  };
}
