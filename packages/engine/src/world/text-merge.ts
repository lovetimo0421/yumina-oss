/**
 * Plain-text diff and three-way merge for the editor's text fields.
 *
 * Live co-editing keeps every open copy of a field in one shared document;
 * this is what reconciles text that reached it from somewhere else — a save
 * from an editor without the field open, the assistant, a restored version,
 * the words a creator typed before the shared copy was opened. Each of those
 * is a change from a known base, and it is merged into the current text
 * rather than written over it, so nobody's typing is lost. Pure.
 */

/** Replace `a.slice(start, end)` with `insert`. */
export interface TextHunk {
  start: number;
  end: number;
  insert: string;
}

/** Above this many changed lines the diff stops looking and sends one hunk. */
const MAX_LINE_EDITS = 800;

function splitLines(s: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) { out.push(s.slice(at, i + 1)); at = i + 1; }
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

/** Common prefix/suffix trimmed off one changed region (character level). */
function trimmedHunk(a: string, aStart: number, aEnd: number, b: string, bStart: number, bEnd: number): TextHunk | null {
  let s = 0;
  const max = Math.min(aEnd - aStart, bEnd - bStart);
  while (s < max && a.charCodeAt(aStart + s) === b.charCodeAt(bStart + s)) s++;
  let e = 0;
  while (e < max - s && a.charCodeAt(aEnd - 1 - e) === b.charCodeAt(bEnd - 1 - e)) e++;
  // Keep a surrogate pair together.
  const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  while (s > 0 && lowSurrogate(a.charCodeAt(aStart + s))) s--;
  while (e > 0 && aEnd - e < a.length && lowSurrogate(a.charCodeAt(aEnd - e))) e--;
  const start = aStart + s;
  const end = aEnd - e;
  const insert = b.slice(bStart + s, bEnd - e);
  if (start === end && insert === "") return null;
  return { start, end, insert };
}

/**
 * Line-level Myers diff: the [aFrom, aTo) / [bFrom, bTo) line ranges that
 * differ, in order, or null when they differ in too many places to bother.
 */
function lineBlocks(a: string[], b: string[]): Array<[number, number, number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, MAX_LINE_EDITS); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
    if (found) break;
  }
  if (!found) return null;
  // Walk back through the trace, collecting the edit script as matched pairs.
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; matches.push([x, y]); }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; matches.push([x, y]); }
  matches.reverse();
  const blocks: Array<[number, number, number, number]> = [];
  let ai = 0;
  let bi = 0;
  for (const [mx, my] of [...matches, [n, m] as [number, number]]) {
    if (mx > ai || my > bi) blocks.push([ai, mx, bi, my]);
    ai = mx + 1;
    bi = my + 1;
  }
  return blocks;
}

/** The hunks that turn `a` into `b`, in order and non-overlapping. */
export function textHunks(a: string, b: string): TextHunk[] {
  if (a === b) return [];
  const al = splitLines(a);
  const bl = splitLines(b);
  const blocks = al.length + bl.length > 4 ? lineBlocks(al, bl) : null;
  if (!blocks) {
    const one = trimmedHunk(a, 0, a.length, b, 0, b.length);
    return one ? [one] : [];
  }
  const aOff = [0];
  for (const line of al) aOff.push(aOff[aOff.length - 1]! + line.length);
  const bOff = [0];
  for (const line of bl) bOff.push(bOff[bOff.length - 1]! + line.length);
  const out: TextHunk[] = [];
  for (const [a0, a1, b0, b1] of blocks) {
    const hunk = trimmedHunk(a, aOff[a0]!, aOff[a1]!, b, bOff[b0]!, bOff[b1]!);
    if (hunk) out.push(hunk);
  }
  return out;
}

/** `a` with `hunks` (from textHunks(a, …)) applied. */
export function applyHunks(a: string, hunks: TextHunk[]): string {
  let out = "";
  let at = 0;
  for (const h of hunks) {
    out += a.slice(at, h.start) + h.insert;
    at = h.end;
  }
  return out + a.slice(at);
}

/**
 * Three-way text merge: `theirs` (the copy everyone is looking at) with the
 * changes `ours` made to `base` carried over. Changes in different places
 * both land; where both rewrote the same stretch, theirs stays and what we
 * typed there is put right after it — never dropped.
 */
export function mergeText(base: string, ours: string, theirs: string): string {
  if (ours === base || ours === theirs) return theirs;
  if (theirs === base) return ours;
  const mine = textHunks(base, ours);
  const other = textHunks(base, theirs);
  // Map each of our hunks into `theirs` coordinates.
  const placed: TextHunk[] = [];
  let j = 0;
  let shift = 0; // theirs index − base index, after the hunks passed so far
  for (const h of mine) {
    // Their hunks entirely before ours (an insert at the same spot counts:
    // theirs goes first).
    while (j < other.length && other[j]!.end <= h.start) {
      shift += other[j]!.insert.length - (other[j]!.end - other[j]!.start);
      j++;
    }
    // Both typed at the same spot, one the start of the other's words (an
    // echo of a save we already had, plus a little more): only the rest.
    const before = j > 0 ? other[j - 1]! : null;
    if (before && h.start === h.end && before.start === before.end && before.start === h.start) {
      if (before.insert.startsWith(h.insert)) continue;
      if (h.insert.startsWith(before.insert)) {
        placed.push({ start: h.start + shift, end: h.start + shift, insert: h.insert.slice(before.insert.length) });
        continue;
      }
    }
    const o = other[j];
    const overlaps = !!o && o.start < h.end && h.start < o.end;
    if (!overlaps) {
      placed.push({ start: h.start + shift, end: h.end + shift, insert: h.insert });
      continue;
    }
    // Both rewrote this stretch: keep their text, add what we typed after it.
    const from = Math.min(o.start, h.start) + shift;
    let end = Math.max(o.end, h.end);
    let k = j;
    let s = shift;
    while (k < other.length && other[k]!.start < end) {
      end = Math.max(end, other[k]!.end);
      s += other[k]!.insert.length - (other[k]!.end - other[k]!.start);
      k++;
    }
    const after = end + s;
    if (h.insert && !theirs.slice(from, after).includes(h.insert)) placed.push({ start: after, end: after, insert: h.insert });
    shift = s;
    j = k;
  }
  // `placed` is ascending in theirs coordinates by construction.
  placed.sort((p, q) => p.start - q.start);
  const clean: TextHunk[] = [];
  for (const p of placed) {
    const last = clean[clean.length - 1];
    if (last && p.start < last.end) continue;
    clean.push(p);
  }
  return applyHunks(theirs, clean);
}

/** A short, stable fingerprint of a JSON-like value: object keys sorted,
 *  undefined dropped (as JSON and a JSONB round trip both do). */
export function stableHash(value: unknown): string {
  const text = stableStringify(value);
  // cyrb53
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "u";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
