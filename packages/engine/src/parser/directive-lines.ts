/**
 * Bracket lines that are state bookkeeping, not story.
 *
 * The directive scanners only remove what they can parse, so every new way a
 * model mangles a directive used to stay visible in the story
 * (`[variableId: game-state.location: set "客厅"]`, `[state: {...}]`,
 * `[log: append "a", append "b"]`, `[events: set "X" true]`, ...). Hiding must
 * not depend on parsing. The rule here works on whole lines:
 *
 *   A line made only of bracket spans is bookkeeping, span by span, when the
 *   span's key (after a placeholder prefix like `variable:`) has a root that
 *   is a variable id of this world, OR the key is a placeholder word that is
 *   not one of its variable ids, OR the value starts with (or chains, after a
 *   comma) a directive operation word.
 *
 * Kept, always: tags the platform consumes (`[image:]`, `[video:]`,
 * `[audio:]`, `[speaker:]`, `[bg:]`), anything a card's reply rule matches,
 * spans with no `key:` at all, and card display lines like `[Day 3: Morning]`
 * or `[时间：清晨]` whose key is not a variable and which carry no operation.
 * Brackets inside a prose line are never touched here.
 */

/** Operation words a directive body starts with (or chains after a comma). */
export const DIRECTIVE_OP_WORDS = [
  "set", "add", "subtract", "multiply", "toggle", "append", "merge", "push", "delete", "update",
] as const;

/** Words models copy from the format line, or from the state block's name,
 *  in place of a real variable id. Compared lower-cased. Never a placeholder
 *  when the world has a variable with that exact id. */
export const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  "variable", "variables", "variableid", "variable_id", "variable-id", "var", "vars",
  "state", "states", "statechanges", "state_changes", "state-changes",
  "update", "updates", "game-state", "game_state", "gamestate",
]);

/** Bracket tags the platform itself reads. Never bookkeeping. */
export const PLATFORM_BRACKET_TAGS: ReadonlySet<string> = new Set(["image", "video", "audio", "speaker", "bg"]);

export interface BracketLineContext {
  /** Variable ids of this world. Without them only the placeholder and
   *  operation-word criteria apply (the streaming bubble before state loads). */
  variableIds?: ReadonlySet<string>;
  /** A card's reply-rule matchers: text they match is left for the card. */
  protect?: readonly RegExp[];
}

export interface BracketSpan {
  /** Offsets into the scanned text, `end` exclusive. */
  start: number;
  end: number;
  text: string;
}

const OP_ALT = DIRECTIVE_OP_WORDS.join("|");
export const OP_FIRST_RE = new RegExp(`^(?:${OP_ALT})(?=$|[\\s"'{\\[\\d+\\-,])`);
const OP_CHAINED_RE = new RegExp(`,\\s*(?:${OP_ALT})(?=[\\s"'{\\[\\d+\\-])`);
const ID_CHARS = "[\\w\\p{L}\\p{N}$·・-]";
/** `<id>:` at the start of a remainder (a placeholder prefix's real key). */
const LEADING_ID_RE = new RegExp(`^(${ID_CHARS}+(?:\\.${ID_CHARS}+(?: ${ID_CHARS}+)*)*)\\s*[:：]\\s*`, "u");
/** `key: rest` — the key may hold spaces (`Day 3`) but no brackets. */
const KEY_RE = /^([^:：[\]{}\n|]{1,80}?)\s*[:：]\s*([\s\S]*)$/;
/** `[mood | calm]`: one pipe where the colon goes. A key only when it is a
 *  variable (a card's `[状态|地点|时间]` status bar is not). */
const PIPE_KEY_RE = /^([^:：[\]{}"\n|]{1,80}?)\s*\|\s*([^|]+)$/;
/** `[group_meta append "x"]`, `[a.b.push "x"]`: no colon, an operation
 *  right after a variable's id or as its last dot segment. */
const NO_COLON_OP_RE = new RegExp(`^(${ID_CHARS}+(?:\\.${ID_CHARS}+)*?)(?:\\.|\\s+)(${OP_ALT})(?:\\s+([\\s\\S]*))?$`, "u");
/** Names of the prompt's own blocks, echoed as a bracket tag
 *  (`[game-state]`, `[/directive-format]`): never story. */
const PROMPT_BLOCK_TAG_RE = /^\/?\s*(?:game[-_ ]?state|directives?|directive[-_ ]format|state[-_ ]reminder|behavio(?:u)?r[-_ ]rules|state[-_ ]changes?d?|variables?|variable[-_ ]updates?|changes?|updates?|)$/i;
/** `[x.y.z: +5]`: a numeric delta on a dot-path is a write, never a label. */
const DOT_PATH_DELTA_RE = /^[+-]\s*\d+(?:\.\d+)?$/;
/** The platform's state receipt written in brackets instead of `<yumina-state …/>`. */
const BRACKET_RECEIPT_RE = /^\/?\s*yumina-state\b/i;
/** `[yeji: mood set "x"]`: an operation as the second word after the colon. */
const OP_SECOND_RE = new RegExp(`^${ID_CHARS}+(?:\\.${ID_CHARS}+)*\\s+(?:${OP_ALT})(?=$|[\\s"'{\\[\\d+\\-,])`, "u");
/** `[No state changes this turn.]` and the like. */
const NO_CHANGE_NOTE_RE = /^(?:no|none|nothing)\b[^\]]{0,40}\b(?:state|variable|change|changes|update|updates)\b[^\]]{0,30}$/i;

/** A span that is bookkeeping with nothing in it to apply: an echoed prompt
 *  block name or a "no state changes" note. */
export function isEmptyBookkeepingSpan(spanText: string): boolean {
  const body = spanText.slice(1, -1).trim();
  return PROMPT_BLOCK_TAG_RE.test(body) || NO_CHANGE_NOTE_RE.test(body) || BRACKET_RECEIPT_RE.test(body);
}

export interface JsonPatchOp { op: string; path: string; value?: unknown }
const PATCH_OPS = new Set(["replace", "add", "insert", "remove", "delta", "merge", "set"]);

/** `[{"op":"replace","path":"/scene_tag","value":"x"}]`: a bare JSON Patch
 *  array, the SillyTavern format without its `<UpdateVariable>` wrapper. */
export function jsonPatchSpan(spanText: string): JsonPatchOp[] | null {
  if (!/^\[\s*\{/.test(spanText)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(spanText); } catch { return null; }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  for (const op of parsed) {
    if (typeof op !== "object" || op === null) return null;
    const { op: kind, path } = op as Record<string, unknown>;
    if (typeof kind !== "string" || !PATCH_OPS.has(kind) || typeof path !== "string" || !path.startsWith("/")) return null;
  }
  return parsed as JsonPatchOp[];
}

/** Index one past the `]` closing the `[` at `p`, or -1. Honours nested
 *  `[]`/`{}` and double-quoted strings; gives up at a blank line. */
export function scanBracketSpan(text: string, p: number, maxLen = 4000): number {
  let square = 0;
  let curly = 0;
  let inString = false;
  const limit = Math.min(text.length, p + maxLen);
  for (let q = p; q < limit; q++) {
    const c = text[q]!;
    if (inString) {
      if (c === "\\") q++;
      else if (c === '"') inString = false;
      else if (c === "\n" && text[q + 1] === "\n") return -1;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[") square++;
    else if (c === "]") {
      square--;
      if (square === 0 && curly <= 0) return q + 1;
      if (square < 0) return -1;
    } else if (c === "{") curly++;
    else if (c === "}") curly--;
    else if (c === "\n" && text[q + 1] === "\n") return -1;
  }
  return -1;
}

/** The parser shields `[image:…]` / `[bg:…]` tags as `\x00IMG<n>\x00` while
 *  it scans; a shielded tag counts as a (platform) span on a bracket line. */
const SHIELD_MARK = "\x00";
function scanShielded(text: string, p: number): number {
  const m = /^\x00IMG\d+\x00/.exec(text.slice(p, p + 16));
  return m ? p + m[0].length : -1;
}

export interface BracketLine {
  /** Start of the line and end of its content (before the newline). */
  start: number;
  end: number;
  spans: BracketSpan[];
}

/** Every line made only of bracket spans (separated by spaces or commas). */
export function findBracketLines(text: string): BracketLine[] {
  const lines: BracketLine[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    let p = i;
    while (p < n && (text[p] === " " || text[p] === "\t")) p++;
    let lineEnd = -1;
    if (text[p] === "[" || text[p] === SHIELD_MARK) {
      const spans: BracketSpan[] = [];
      for (;;) {
        const q = text[p] === SHIELD_MARK ? scanShielded(text, p) : scanBracketSpan(text, p);
        if (q < 0) break;
        spans.push({ start: p, end: q, text: text.slice(p, q) });
        let r = q;
        while (r < n && (text[r] === " " || text[r] === "\t" || text[r] === "," || text[r] === "\r")) r++;
        if (r >= n || text[r] === "\n") { lineEnd = r; break; }
        if (text[r] !== "[" && text[r] !== SHIELD_MARK) break;
        p = r;
      }
      if (lineEnd >= 0) lines.push({ start: i, end: lineEnd, spans });
    }
    const nl = text.indexOf("\n", lineEnd >= 0 ? lineEnd : i);
    if (nl < 0) break;
    i = nl + 1;
  }
  return lines;
}

/** The key and value of a span's body, with placeholder prefixes peeled
 *  (`[variable: mood: set "x"]` → `mood`, `set "x"`). Null when the span has
 *  no `key:` at all. */
export function spanKey(spanText: string, ids?: ReadonlySet<string>): { rawKey: string; key: string; rest: string } | null {
  const body = spanText.slice(1, -1).trim();
  let m = KEY_RE.exec(body);
  if (!m && ids) {
    const pipe = PIPE_KEY_RE.exec(body);
    if (pipe && ids.has(keyRoot(pipe[1]!.trim(), ids))) m = pipe;
  }
  if (!m && ids) {
    const bare = NO_COLON_OP_RE.exec(body);
    if (bare && ids.has(keyRoot(bare[1]!, ids))) {
      return { rawKey: bare[1]!, key: bare[1]!, rest: `${bare[2]} ${bare[3] ?? ""}`.trim() };
    }
  }
  if (!m) return null;
  const rawKey = m[1]!.trim();
  // `roster."frodo".mood` → `roster.frodo.mood`.
  let key = rawKey.replace(/"/g, "");
  let rest = m[2]!.trim();
  // Peel prefixes: a placeholder word (`variable:`, `state:`), or any key
  // that is not a variable when what follows is `<id>:` and then an
  // operation or a real variable (`[_s: weather: set "x"]`).
  for (let guard = 0; guard < 3; guard++) {
    const inner = LEADING_ID_RE.exec(rest);
    if (!inner) break;
    const after = rest.slice(inner[0].length).trim();
    const keyIsVar = ids?.has(keyRoot(key, ids)) ?? false;
    const peel = isPlaceholderKey(key, ids)
      || (!keyIsVar && (OP_FIRST_RE.test(after) || (ids?.has(keyRoot(inner[1]!, ids)) ?? false)));
    if (!peel) break;
    key = inner[1]!;
    rest = after;
  }
  return { rawKey, key, rest };
}

export function isPlaceholderKey(key: string, ids?: ReadonlySet<string>): boolean {
  return PLACEHOLDER_KEYS.has(key.toLowerCase()) && !ids?.has(key);
}

/** The variable a key writes: its first dot-path segment, after dropping
 *  placeholder roots (`game-state.location` → `location`). */
export function keyRoot(key: string, ids?: ReadonlySet<string>): string {
  const parts = key.replace(/\[(\d+)\]/g, ".$1").split(".").map((s) => s.trim()).filter(Boolean);
  while (parts.length > 1 && isPlaceholderKey(parts[0]!, ids)) parts.shift();
  return parts[0] ?? "";
}

/** The key with placeholder roots dropped (`game-state.location` → `location`). */
export function stripPlaceholderRoots(key: string, ids?: ReadonlySet<string>): string {
  const parts = key.split(".");
  while (parts.length > 1 && isPlaceholderKey(parts[0]!.trim(), ids)) parts.shift();
  return parts.join(".");
}

export type SpanKind = "platform" | "bookkeeping" | "display";

/** What a bracket span on a bracket-only line is. */
export function classifyBracketSpan(spanText: string, ctx: BracketLineContext = {}): SpanKind {
  if (spanText.startsWith(SHIELD_MARK)) return "platform";
  const ids = ctx.variableIds;
  if (isEmptyBookkeepingSpan(spanText) || jsonPatchSpan(spanText)) return "bookkeeping";
  const parsed = spanKey(spanText, ids);
  if (!parsed) return "display";
  if (PLATFORM_BRACKET_TAGS.has(parsed.rawKey.toLowerCase()) && !ids?.has(parsed.rawKey)) return "platform";
  if (ids && ids.has(keyRoot(parsed.key, ids))) return "bookkeeping";
  if (isPlaceholderKey(parsed.rawKey, ids)) return "bookkeeping";
  // `[game-state.npc.mood: {…}]`: a placeholder as the path's root.
  const firstSegment = parsed.rawKey.split(".")[0]!.trim();
  if (parsed.rawKey.includes(".") && isPlaceholderKey(firstSegment, ids)) return "bookkeeping";
  if (parsed.key.includes(".") && DOT_PATH_DELTA_RE.test(parsed.rest)) return "bookkeeping";
  if (OP_FIRST_RE.test(parsed.rest) || OP_CHAINED_RE.test(parsed.rest) || OP_SECOND_RE.test(parsed.rest)) return "bookkeeping";
  return "display";
}

function isProtected(text: string, protect?: readonly RegExp[]): boolean {
  if (!protect?.length) return false;
  return protect.some((re) => new RegExp(re.source, re.flags.replace(/[gy]/g, "")).test(text));
}

export interface StrippedBracketLines {
  text: string;
  /** The bookkeeping spans taken out, in order. */
  removed: string[];
}

/** Remove the bookkeeping spans of every bracket-only line; a line left with
 *  nothing goes whole, with its line break. */
export function stripBookkeepingLines(text: string, ctx: BracketLineContext = {}): StrippedBracketLines {
  if (!text.includes("[")) return { text, removed: [] };
  const lines = findBracketLines(text);
  if (!lines.length) return { text, removed: [] };
  const removed: string[] = [];
  let out = "";
  let cursor = 0;
  for (const line of lines) {
    const lineText = text.slice(line.start, line.end);
    if (isProtected(lineText, ctx.protect)) continue;
    const kept: string[] = [];
    let dropped = 0;
    for (const span of line.spans) {
      if (classifyBracketSpan(span.text, ctx) === "bookkeeping") { removed.push(span.text); dropped++; }
      else kept.push(span.text);
    }
    if (!dropped) continue;
    out += text.slice(cursor, line.start);
    if (kept.length) {
      out += text.slice(line.start, line.spans[0]!.start) + kept.join(" ");
      cursor = line.end;
    } else {
      // Drop the line and its own newline.
      cursor = text[line.end] === "\n" ? line.end + 1 : line.end;
    }
  }
  out += text.slice(cursor);
  return { text: out, removed };
}
