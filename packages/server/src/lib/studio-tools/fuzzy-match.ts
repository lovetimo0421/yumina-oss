/**
 * Whitespace-tolerant, self-healing text matching for edit_custom_ui.
 *
 * Storage-agnostic (operates on plain strings) so it survives any future
 * substrate/harness swap — same reasoning as tsx-validate.ts.
 *
 * Why this exists: the #1 large-file edit failure is "old_code not found"
 * because the model reproduced a code region with slightly different
 * indentation/whitespace than the file actually has. A strict string match
 * rejects it, the model re-reads (read-spiral), and nothing gets edited. This
 * adds a whitespace-insensitive UNIQUE fallback, and a near-miss hint that shows
 * the real current region so the model can self-correct without re-reading.
 *
 * Safety: the fuzzy fallback only fires when it finds EXACTLY ONE
 * whitespace-normalized match. Ambiguous matches fall through to the hint —
 * we never silently edit the wrong region.
 */

export interface MatchSpan {
  /** start index (inclusive) in the original haystack */
  start: number;
  /** end index (exclusive) in the original haystack */
  end: number;
}

/**
 * Normalize a string by collapsing every run of whitespace to a single space,
 * while recording, for each normalized char, the original [start,end) span it
 * came from. Lets us map a match in normalized space back to exact original
 * indices.
 */
function normalizeWithMap(s: string): { norm: string; starts: number[]; ends: number[] } {
  const norm: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i]!)) {
      const runStart = i;
      while (i < s.length && /\s/.test(s[i]!)) i++;
      norm.push(" ");
      starts.push(runStart);
      ends.push(i);
    } else {
      norm.push(s[i]!);
      starts.push(i);
      ends.push(i + 1);
      i++;
    }
  }
  return { norm: norm.join(""), starts, ends };
}

const MIN_FUZZY_LEN = 8; // below this, a whitespace-normalized match is too risky

/**
 * Find `needle` inside `haystack` ignoring whitespace differences. Returns the
 * exact original span iff there is exactly one normalized match, else null
 * (not found OR ambiguous — caller should fall back to a hint).
 */
export function fuzzyFindUnique(haystack: string, needle: string): MatchSpan | null {
  const h = normalizeWithMap(haystack);
  const n = normalizeWithMap(needle);

  // Trim the single-space sentinels the needle's leading/trailing whitespace produced.
  let a = 0;
  let b = n.norm.length;
  while (a < b && n.norm[a] === " ") a++;
  while (b > a && n.norm[b - 1] === " ") b--;
  const needleNorm = n.norm.slice(a, b);
  if (needleNorm.length < MIN_FUZZY_LEN) return null;

  const first = h.norm.indexOf(needleNorm);
  if (first === -1) return null;
  if (h.norm.indexOf(needleNorm, first + 1) !== -1) return null; // ambiguous

  const startK = first;
  const endK = first + needleNorm.length - 1;
  return { start: h.starts[startK]!, end: h.ends[endK]! };
}

/**
 * Build a numbered code window around the region of `haystack` most similar to
 * `needle`, for a "closest current region" hint when no match is found. Anchors
 * on the longest distinctive line of the needle.
 */
export function nearestRegion(haystack: string, needle: string, contextLines = 4): string | null {
  const hLines = haystack.split("\n");
  const window = (hit: number): string => {
    const start = Math.max(0, hit - contextLines);
    const end = Math.min(hLines.length - 1, hit + contextLines);
    const width = String(end + 1).length;
    return hLines
      .slice(start, end + 1)
      .map((t, k) => `${String(start + k + 1).padStart(width)} | ${t}`)
      .join("\n");
  };

  // 1) Precise: a needle line that appears verbatim (or as a substring) in the file.
  const lineAnchors = needle
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 6)
    .sort((x, y) => y.length - x.length);
  for (const anchor of lineAnchors) {
    const hit = hLines.findIndex((l) => l.trim() === anchor || l.includes(anchor));
    if (hit !== -1) return window(hit);
  }

  // 2) Fallback: the "same line, changed value" case (e.g. old_code had a different
  // string/number literal). Anchor on the most distinctive identifier token shared
  // with the file, so the hint still points at the right region.
  const tokens = Array.from(new Set(needle.match(/[A-Za-z_$][\w$]{3,}/g) ?? []))
    .sort((x, y) => y.length - x.length);
  for (const tok of tokens) {
    const hit = hLines.findIndex((l) => l.includes(tok));
    if (hit !== -1) return window(hit);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-strategy replacer cascade (ported/adapted from opencode's tool/edit.ts,
// MIT — github.com/anomalyco/opencode). The #1 large-file edit failure is the
// model reproducing a code region with slightly different indentation, escaping,
// or a near-miss middle line. A single exact-match check rejects all of these and
// forces a read-spiral. This cascade tries progressively looser matchers, but each
// only resolves when the candidate it surfaces is UNIQUE in the file — so we never
// silently edit the wrong region.
//
// Each replacer is a generator that yields candidate substrings which (after the
// relaxation) should exist verbatim in the file. The driver verifies each candidate
// via indexOf and only applies it when indexOf === lastIndexOf (unique).
// ─────────────────────────────────────────────────────────────────────────────

type Replacer = (content: string, find: string) => Generator<string>;

/** Levenshtein edit distance (iterative two-row DP). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

/** 0..1 similarity between two single lines (1 = identical). */
function lineSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Exact char span of the substring covering lines [startLine, endLine],
 *  EXCLUDING the trailing newline after endLine (so a replacement preserves the
 *  line break that follows the matched block). The result is always a real
 *  substring of `content`, so the driver's indexOf verification holds. */
function lineRangeSubstring(content: string, lines: string[], startLine: number, endLine: number): string {
  let start = 0;
  for (let k = 0; k < startLine; k++) start += lines[k]!.length + 1;
  let end = start;
  for (let k = startLine; k <= endLine; k++) {
    end += lines[k]!.length;
    if (k < endLine) end += 1;
  }
  return content.slice(start, end);
}

/** Split a find block into lines, dropping a single trailing empty line (the
 *  newline most blocks end on) so line counts line up with file slices. */
function splitSearchLines(find: string): string[] {
  const lines = find.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 1. Exact match. */
const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

/** 2. Per-line trimmed match (tolerates leading/trailing whitespace per line). */
const LineTrimmedReplacer: Replacer = function* (content, find) {
  const lines = content.split("\n");
  const search = splitSearchLines(find);
  if (search.length === 0) return;
  for (let i = 0; i + search.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < search.length; j++) {
      if (lines[i + j]!.trim() !== search[j]!.trim()) { ok = false; break; }
    }
    if (ok) yield lineRangeSubstring(content, lines, i, i + search.length - 1);
  }
};

/** 3. Anchor on first + last line, score the middle by similarity (>=3 lines). */
const BlockAnchorReplacer: Replacer = function* (content, find) {
  const lines = content.split("\n");
  const search = splitSearchLines(find);
  if (search.length < 3) return;
  const firstLine = search[0]!.trim();
  const lastLine = search[search.length - 1]!.trim();
  const searchMiddle = search.slice(1, -1).map((l) => l.trim());

  const candidates: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== firstLine) continue;
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j]!.trim() === lastLine) { candidates.push({ start: i, end: j }); break; }
    }
  }
  if (candidates.length === 0) return;

  const score = (c: { start: number; end: number }): number => {
    if (searchMiddle.length === 0) return 1;
    const middle = lines.slice(c.start + 1, c.end).map((l) => l.trim());
    let total = 0;
    for (let k = 0; k < searchMiddle.length; k++) total += lineSimilarity(searchMiddle[k]!, middle[k] ?? "");
    return total / searchMiddle.length;
  };

  let best = candidates[0]!;
  let bestScore = score(best);
  for (let i = 1; i < candidates.length; i++) {
    const s = score(candidates[i]!);
    if (s > bestScore) { bestScore = s; best = candidates[i]!; }
  }
  // A single anchored candidate is accepted on the anchors alone; with several,
  // require a minimally similar middle so we pick the right block.
  const threshold = candidates.length === 1 ? 0 : 0.3;
  if (bestScore >= threshold) yield lineRangeSubstring(content, lines, best.start, best.end);
};

/** 4. Whitespace-normalized unique match (collapse all whitespace runs). */
const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const h = normalizeWithMap(content);
  const n = normalizeWithMap(find);
  let a = 0;
  let b = n.norm.length;
  while (a < b && n.norm[a] === " ") a++;
  while (b > a && n.norm[b - 1] === " ") b--;
  const needle = n.norm.slice(a, b);
  if (needle.length < MIN_FUZZY_LEN) return;
  let from = 0;
  for (;;) {
    const idx = h.norm.indexOf(needle, from);
    if (idx === -1) break;
    yield content.slice(h.starts[idx]!, h.ends[idx + needle.length - 1]!);
    from = idx + 1;
  }
};

/** 5. Indentation-flexible: strip common leading indent from both sides. */
const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndent = (text: string): string => {
    const ls = text.split("\n");
    const indents = ls.filter((l) => l.trim().length > 0).map((l) => l.match(/^\s*/)![0].length);
    const min = indents.length ? Math.min(...indents) : 0;
    return ls.map((l) => l.slice(min)).join("\n");
  };
  const search = splitSearchLines(find);
  if (search.length === 0) return;
  const normFind = removeIndent(search.join("\n"));
  const lines = content.split("\n");
  for (let i = 0; i + search.length <= lines.length; i++) {
    const block = lines.slice(i, i + search.length).join("\n");
    if (removeIndent(block) === normFind) yield lineRangeSubstring(content, lines, i, i + search.length - 1);
  }
};

/** 6. Escape-normalized: unescape literal \n \t \" etc. the model may have emitted. */
const EscapeNormalizedReplacer: Replacer = function* (_content, find) {
  const unescaped = find.replace(/\\(n|t|r|'|"|`|\\|\$)/g, (_m, ch: string) => {
    switch (ch) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "\\": return "\\";
      default: return ch; // ' " ` $ → the literal char
    }
  });
  if (unescaped !== find) yield unescaped;
};

/** 7. Trimmed-boundary: ignore leading/trailing whitespace of the whole block. */
const TrimmedBoundaryReplacer: Replacer = function* (_content, find) {
  const trimmed = find.trim();
  if (trimmed.length > 0 && trimmed !== find) yield trimmed;
};

/** 8. Context-aware: first+last anchors, same line count, >=50% middle match. */
const ContextAwareReplacer: Replacer = function* (content, find) {
  const lines = content.split("\n");
  const search = splitSearchLines(find);
  if (search.length < 3) return;
  const firstLine = search[0]!.trim();
  const lastLine = search[search.length - 1]!.trim();
  for (let i = 0; i + search.length <= lines.length; i++) {
    if (lines[i]!.trim() !== firstLine) continue;
    if (lines[i + search.length - 1]!.trim() !== lastLine) continue;
    let nonEmpty = 0;
    let matched = 0;
    for (let j = 1; j < search.length - 1; j++) {
      const s = search[j]!.trim();
      if (!s) continue;
      nonEmpty++;
      if (lines[i + j]!.trim() === s) matched++;
    }
    if (nonEmpty === 0 || matched / nonEmpty >= 0.5) {
      yield lineRangeSubstring(content, lines, i, i + search.length - 1);
      return;
    }
  }
};

const REPLACERS: Array<[string, Replacer]> = [
  ["simple", SimpleReplacer],
  ["line-trimmed", LineTrimmedReplacer],
  ["block-anchor", BlockAnchorReplacer],
  ["whitespace-normalized", WhitespaceNormalizedReplacer],
  ["indentation-flexible", IndentationFlexibleReplacer],
  ["escape-normalized", EscapeNormalizedReplacer],
  ["trimmed-boundary", TrimmedBoundaryReplacer],
  ["context-aware", ContextAwareReplacer],
];

export type EditMatch =
  | { ok: true; span: MatchSpan; strategy: string }
  | { ok: false; reason: "not-found" | "ambiguous" };

/**
 * Resolve the unique span in `content` to replace for a given `find` string,
 * trying each strategy in order. A candidate is only accepted when it occurs
 * EXACTLY ONCE in the file. Returns the first unique match, else "ambiguous"
 * (a candidate existed but matched multiple places) or "not-found".
 */
export function resolveUniqueMatch(content: string, find: string): EditMatch {
  let sawCandidate = false;
  for (const [strategy, replacer] of REPLACERS) {
    for (const candidate of replacer(content, find)) {
      if (!candidate) continue;
      const index = content.indexOf(candidate);
      if (index === -1) continue;
      sawCandidate = true;
      if (index !== content.lastIndexOf(candidate)) continue; // ambiguous candidate — keep trying
      return { ok: true, span: { start: index, end: index + candidate.length }, strategy };
    }
  }
  return { ok: false, reason: sawCandidate ? "ambiguous" : "not-found" };
}
