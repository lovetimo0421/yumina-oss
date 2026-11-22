/**
 * An update to a card that is already live after an approval is judged on
 * what changed, not as a whole card again (Jason, 11/12: "更新只检查变化的地方").
 * Authors often only touch the interface code, and every such update used to
 * re-judge the whole card: Addanc's DxD card went to a person on every update
 * for the same minors note on text he never touched.
 *
 * Pure (no I/O): what changed between the live card and the held edit, and
 * whether that can be judged on its own or the whole card needs a look again.
 * world-ai-review-run.ts loads both sides and the pictures.
 */
import { isOfficialPresetContent } from "@yumina/engine";
import { explicitWordIn, keywordPassages, minorWordIn, type WorldReviewInput } from "./world-ai-review-core.js";

/** One side of an update: the live card, or the held edit as approval would publish it. */
export interface ReviewSide {
  name: string;
  description: string | null;
  tags: unknown;
  ageRating: string;
  targetAudience: string;
  blurCover: boolean | null;
  thumbnailUrl: string | null;
  galleryImages: string[];
  schema: unknown;
}

/** Why an update still gets the whole-card look. */
export type FullReviewWhy =
  | "new"             // nothing of this card is live
  | "not_approved"    // live, but never approved by a review (legacy card)
  | "rating_changed"  // Limited <-> Limitless: what is fine depends on the whole card
  | "audience_changed"
  | "mostly_new";     // most of the card's text was replaced

export interface UpdateChanges {
  /** The new name, when it changed. */
  name: string | null;
  /** The new description, when it changed. */
  description: string | null;
  addedTags: string[];
  /** Lore and openings added or rewritten: the whole entry when short, else the changed lines. */
  entries: Array<{ name: string; op: "added" | "modified"; text: string }>;
  /** Interface code: only the changed lines, with a little context. */
  code: Array<{ file: string; op: "added" | "modified"; text: string }>;
  /** Every changed or added line anywhere (entries, code, variables, situations…), for the keyword scan. */
  scanText: string;
  /** The portrait or desktop cover changed, or its blur did. */
  coverChanged: boolean;
  /** Characters of new text, against the size of the whole card's text. */
  changedChars: number;
  totalChars: number;
}

export type ReviewScope = { mode: "full"; why: FullReviewWhy } | { mode: "changes"; changes: UpdateChanges };

/** Past this share of the card's text being new, the update is judged as a whole card. */
export const MOSTLY_NEW_SHARE = 0.6;
/** An entry this short is shown whole when it changes; a longer one, only its changed lines. */
const WHOLE_ENTRY_CHARS = 3_000;
const HUNK_CONTEXT_LINES = 2;
const MAX_LINE_CHARS = 2_000;

type Row = Record<string, unknown>;

function ratingClass(v: string | null | undefined): "all" | "sensitive" {
  return v === "all" || v == null || v === "" ? "all" : "sensitive";
}
function audienceOf(v: string | null | undefined): string {
  return v === "male" || v === "female" ? v : "all";
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function obj(v: unknown): Row {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
}
/**
 * Entries the card's AI reads, minus the platform's own presets exactly as
 * shipped. The "system-presets" section itself is where most authors keep
 * their characters and rules (always sent), so it counts as the author's text.
 */
function entriesOf(schema: unknown): Map<string, Row> {
  const list = Array.isArray(obj(schema).entries) ? obj(schema).entries as Row[] : [];
  const map = new Map<string, Row>();
  list.forEach((e, i) => {
    if (!e || typeof e !== "object") return;
    if (typeof e.presetId === "string" && isOfficialPresetContent(e.presetId, str(e.content))) return;
    map.set(typeof e.id === "string" && e.id ? e.id : `#${i}`, e);
  });
  return map;
}
function filesOf(schema: unknown): Record<string, string> {
  const files = obj(obj(schema).rootComponent).files;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(files))) if (typeof v === "string") out[k] = v;
  return out;
}

export function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of text.split("\n")) { const k = l.trim(); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
  return counts;
}

/**
 * The lines of `after` that are not in `before` (as a multiset, so moved lines
 * don't count), shown with a little context. `changed` counts the characters
 * of new lines; `lines` is every new line, for the keyword scan. A `before`
 * given as {@link lineCounts} is a shared pool, used up as it matches: each
 * old line explains one new line across every call that shares it.
 */
export function changedHunks(before: string | Map<string, number>, after: string, context = HUNK_CONTEXT_LINES): { text: string; changed: number; lines: string[] } {
  const left = typeof before === "string" ? lineCounts(before) : before;
  const lines = after.split("\n");
  const fresh = lines.map((l) => {
    const k = l.trim();
    if (!k) return false;
    const n = left.get(k) ?? 0;
    if (n > 0) { left.set(k, n - 1); return false; }
    return true;
  });
  const show = new Array<boolean>(lines.length).fill(false);
  const added: string[] = [];
  let changed = 0;
  fresh.forEach((isNew, i) => {
    if (!isNew) return;
    added.push(lines[i]!);
    changed += lines[i]!.trim().length;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) show[j] = true;
  });
  const out: string[] = [];
  let gap = false;
  show.forEach((s, i) => {
    if (!s) { gap = true; return; }
    if (gap && out.length) out.push("…");
    gap = false;
    const line = lines[i]!;
    out.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
  });
  return { text: out.join("\n").trim(), changed, lines: added };
}

/** Every string in the schema outside entries and interface code (variables, situations, rules, the interface doc…). */
function otherStrings(schema: unknown): string[] {
  const s = { ...obj(schema) };
  delete s.entries;
  delete s.rootComponent;
  delete s.landscapeCover;
  const out: string[] = [];
  let size = 0;
  const walk = (v: unknown, depth: number): void => {
    if (size > 4_000_000 || depth > 40) return;
    if (typeof v === "string") {
      if (v.startsWith("data:") || !/\p{L}/u.test(v)) return;
      out.push(v); size += v.length;
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(s, 0);
  return out;
}

/** Everything the author wrote: name, description, entries (their own
 *  system presets included), interface code and every other string. */
function authorText(side: ReviewSide): string {
  return [
    side.name, side.description ?? "",
    ...[...entriesOf(side.schema).values()].flatMap((e) => [str(e.name), str(e.content)]),
    ...Object.values(filesOf(side.schema)),
    ...otherStrings(side.schema),
  ].join("\n");
}

/** What changed between the live card and the held edit. */
export function diffForReview(before: ReviewSide, after: ReviewSide): UpdateChanges {
  const scan: string[] = [];
  let changedChars = 0;
  let totalChars = 0;

  const entries: UpdateChanges["entries"] = [];
  const prevEntries = entriesOf(before.schema);
  // A new entry is compared with all the old text: lore split, merged or
  // re-imported under new ids is not new writing.
  const oldEntryLines = lineCounts([...prevEntries.values()].map((e) => str(e.content)).join("\n"));
  for (const [id, e] of entriesOf(after.schema)) {
    const content = str(e.content);
    const name = str(e.name);
    totalChars += content.length;
    const prev = prevEntries.get(id);
    // An entry switched back on reads as new: its text reaches players again.
    const reEnabled = !!prev && prev.enabled === false && e.enabled !== false;
    const prevContent = reEnabled ? "" : prev ? str(prev.content) : oldEntryLines;
    const renamed = !!prev && name !== str(prev.name);
    if (prev && !reEnabled && content === prevContent && !renamed) continue;
    const hunks = changedHunks(prevContent, content);
    if (renamed) { scan.push(name); changedChars += name.length; }
    if (hunks.changed === 0 && !renamed) continue; // nothing but blank lines, moved lines or old text
    scan.push(...hunks.lines);
    changedChars += hunks.changed;
    const op = prev && !reEnabled ? "modified" : "added";
    const text = hunks.changed === 0 ? ""
      : content.length <= WHOLE_ENTRY_CHARS ? content : hunks.text;
    entries.push({ name, op, text });
  }

  // Code is compared with all the old code, so a file renamed or split is not new.
  const code: UpdateChanges["code"] = [];
  const prevFiles = filesOf(before.schema);
  const oldCodeLines = lineCounts(Object.values(prevFiles).join("\n"));
  for (const [file, source] of Object.entries(filesOf(after.schema))) {
    totalChars += source.length;
    if (prevFiles[file] === source) continue;
    const hunks = changedHunks(oldCodeLines, source);
    if (hunks.changed === 0) continue;
    scan.push(...hunks.lines);
    changedChars += hunks.changed;
    code.push({ file, op: file in prevFiles ? "modified" : "added", text: hunks.text });
  }

  // Variables, situations, rules and the like only ever reach the models
  // through the keyword scan (as in the full look), so new ones are scanned.
  const prevOther = new Map<string, number>();
  for (const s of otherStrings(before.schema)) prevOther.set(s, (prevOther.get(s) ?? 0) + 1);
  for (const s of otherStrings(after.schema)) {
    const n = prevOther.get(s) ?? 0;
    if (n > 0) { prevOther.set(s, n - 1); continue; }
    scan.push(s);
  }

  const name = after.name !== before.name ? after.name : null;
  const description = (after.description ?? "") !== (before.description ?? "") ? after.description ?? "" : null;
  if (name) scan.push(name);
  if (description !== null) scan.push(description);
  const tagsOf = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const prevTags = new Set(tagsOf(before.tags));
  const addedTags = tagsOf(after.tags).filter((t) => !prevTags.has(t));
  scan.push(...addedTags);

  const landscape = (side: ReviewSide) => str(obj(side.schema).landscapeCover).trim();
  // Blur as listings apply it: never on Limited, unset means blurred on Limitless.
  const blurred = (side: ReviewSide) => ratingClass(side.ageRating) === "sensitive" && (side.blurCover ?? true);
  const coverChanged = (after.thumbnailUrl ?? "").trim() !== (before.thumbnailUrl ?? "").trim()
    || landscape(after) !== landscape(before)
    || blurred(after) !== blurred(before);

  return { name, description, addedTags, entries, code, scanText: scan.join("\n"), coverChanged, changedChars, totalChars };
}

/**
 * Whether an update can be judged on its changes. `before` is the live card
 * (null when nothing is live) and `approved` says a review approved it. A
 * rating change either way is a whole-card question: Limitless → Limited
 * must hold for every part of the card, and Limited → Limitless turns young
 * characters the card already had into a minors question.
 */
export function chooseReviewScope(before: ReviewSide | null, after: ReviewSide, approved: boolean): ReviewScope {
  if (!before) return { mode: "full", why: "new" };
  if (!approved) return { mode: "full", why: "not_approved" };
  if (ratingClass(before.ageRating) !== ratingClass(after.ageRating)) return { mode: "full", why: "rating_changed" };
  if (audienceOf(before.targetAudience) !== audienceOf(after.targetAudience)) return { mode: "full", why: "audience_changed" };
  const changes = diffForReview(before, after);
  if (changes.totalChars > 0 && changes.changedChars > changes.totalChars * MOSTLY_NEW_SHARE) return { mode: "full", why: "mostly_new" };
  return { mode: "changes", changes };
}

/** True when nothing in the update is anything the models judge: no new
 *  text for them to read, no keyword hit in other changed text, the cover as
 *  it was. Pictures are checked separately (they need loading). */
export function nothingToRead(changes: UpdateChanges): boolean {
  return changes.name === null && changes.description === null && !changes.coverChanged
    && changes.entries.length === 0 && changes.code.length === 0
    && !explicitWordIn(changes.scanText) && !minorWordIn(changes.scanText);
}

/** What the admin queue shows about an update judged on its changes. */
export interface ChangeSummary {
  entries: number;
  files: number;
  pictures: number;
  cover: boolean;
  description: boolean;
}

export function summarizeChanges(changes: UpdateChanges, pictures: number): ChangeSummary {
  return {
    entries: changes.entries.length, files: changes.code.length, pictures,
    cover: changes.coverChanged, description: changes.description !== null || changes.name !== null,
  };
}

/** Wider than the explicit-word list: any sign the changed text is sexual. */
const SEXUAL_HINT = /\b(?:sex|sexual\w*|sexy|naked|nude|nudity|breasts?|boobs?|tits|moan\w*|arous\w*|horny|lust\w*|thrust\w*|undress\w*|seduc\w*|erotic\w*|kinky?|fetish\w*|aphrodisiac\w*|in heat|make love|making love|made love)\b|性爱|性愛|性行为|裸|乳房|胸部|呻吟|高潮|情欲|情慾|欲火|勃起|调教|調教|发情|發情|春药|春藥|侍寝|侍寢|エロ|セックス|おっぱい|喘ぎ|発情/i;

/** What the models are given for an update judged on its changes. */
export function updateReviewInput(after: ReviewSide, changes: UpdateChanges, seen: {
  cover: Buffer | null; coverError?: string; innerImages: Buffer[]; unseenImages: number;
}): WorldReviewInput {
  const explicitWord = explicitWordIn(changes.scanText);
  // New sexual text could be about a character whose age only the unchanged
  // card states: then those ages go along as context. Only then: listed
  // beside non-sexual changes, a model flags the old text through them (a
  // 15-year-old in a battle-royale roster, 11/12 backtest).
  const ageContext = explicitWord || SEXUAL_HINT.test(changes.scanText.normalize("NFKC"))
    ? keywordPassages(authorText(after), 8, "minor") : [];
  return {
    name: after.name, description: "", tags: Array.isArray(after.tags) ? after.tags.map(String) : [],
    ageRating: after.ageRating, targetAudience: after.targetAudience, blurCover: after.blurCover,
    contentText: "", cover: seen.cover, coverError: seen.coverError,
    innerImages: seen.innerImages, unseenImages: seen.unseenImages,
    explicitWord, minorWord: minorWordIn(changes.scanText),
    passages: keywordPassages(changes.scanText),
    update: { changes, ageContext },
  };
}
