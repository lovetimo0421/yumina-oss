/** Regex to detect a user-supplied regex pattern like /pattern/flags */
const USER_REGEX_RE = /^\/(.+)\/([gimsuy]*)$/;

/** Scripts written without spaces between words: there is no word edge to
 *  find, so a keyword's character there matches wherever it appears, and a
 *  neighbour from one of them ends a Latin word ("我去了Hogsmeade村"). */
const UNSPACED = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}";
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const UNSPACED_CHAR = new RegExp(`[${UNSPACED}]`, "u");
/** A letter, digit or underscore that would continue a space-separated word. */
const JOINING = `(?![${UNSPACED}])[\\p{L}\\p{N}_]`;

const needsEdge = (ch: string | undefined) => !!ch && WORD_CHAR.test(ch) && !UNSPACED_CHAR.test(ch);

/** A whole-word pattern for `keyword`. Each end gets a boundary only when the
 *  keyword's character there belongs to a space-separated script: `\b` only
 *  knows ASCII, so it never matched a Chinese or Japanese keyword at all and
 *  cut "José" off at the é. A consumed prefix instead of a lookbehind keeps it
 *  working on older Safari. */
export function wholeWordPattern(keyword: string): RegExp {
  const chars = [...keyword.trim()];
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = needsEdge(chars[0]) ? `(?:^|(?!${JOINING}).)` : "";
  const right = needsEdge(chars[chars.length - 1]) ? `(?!${JOINING})` : "";
  return new RegExp(`${left}${escaped}${right}`, "isu");
}

/**
 * Check if a single keyword matches anywhere in the text.
 *
 * Match chain:
 * 1. If keyword looks like `/regex/flags` → try regex match
 * 2. If `wholeWord` → whole-word match (see wholeWordPattern)
 * 3. Else → substring `text.includes(keyword)`
 *
 * All matching is case-insensitive.
 */
export function keywordMatches(
  text: string,
  keyword: string,
  wholeWord: boolean
): boolean {
  const lowerKeyword = keyword.toLowerCase();

  // 1. User-supplied regex: /pattern/flags
  if (keyword.startsWith("/")) {
    const re = userRegex(keyword);
    if (re) {
      // A cached g/y regex keeps lastIndex between calls; a fresh one started at 0.
      re.lastIndex = 0;
      if (re.test(text)) return true;
    }
    // Invalid regex or no match — fall through
  }

  // 2. Whole-word matching
  if (wholeWord) {
    if (!lowerKeyword.trim()) return false;
    const patterns = wholeWordPatterns(lowerKeyword);
    // The full pattern contains the keyword literal with the same flags, so a
    // text without the literal cannot match it. The literal scan is several
    // times faster than the edge-checking pattern, whose consumed prefix keeps
    // V8 from jumping straight to the keyword (20x slower after 253ecc1e0).
    return !!patterns && patterns.literal.test(text) && patterns.full.test(text);
  }

  // 3. Substring matching (default)
  return lowerOf(text).includes(lowerKeyword);
}

// A turn checks every keyword of every entry against the same scan text, so
// the lowercase copy and the compiled patterns are reused instead of rebuilt
// once per keyword. Neither changes a result: patterns hold no g/y state, and
// the user regex is reset before each test.
let lastText: string | null = null;
let lastLower = "";
function lowerOf(text: string): string {
  if (text !== lastText) { lastText = text; lastLower = text.toLowerCase(); }
  return lastLower;
}

const PATTERN_CACHE_MAX = 10_000;
const wholeWordCache = new Map<string, { literal: RegExp; full: RegExp } | null>();
function wholeWordPatterns(lowerKeyword: string): { literal: RegExp; full: RegExp } | null {
  let hit = wholeWordCache.get(lowerKeyword);
  if (hit === undefined) {
    try {
      const escaped = lowerKeyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      hit = { literal: new RegExp(escaped, "isu"), full: wholeWordPattern(lowerKeyword) };
    } catch {
      hit = null;
    }
    if (wholeWordCache.size >= PATTERN_CACHE_MAX) wholeWordCache.clear();
    wholeWordCache.set(lowerKeyword, hit);
  }
  return hit;
}

const userRegexCache = new Map<string, RegExp | null>();
function userRegex(keyword: string): RegExp | null {
  let hit = userRegexCache.get(keyword);
  if (hit === undefined) {
    hit = null;
    const regexMatch = USER_REGEX_RE.exec(keyword);
    if (regexMatch) {
      try {
        const flags = regexMatch[2]!.includes("i") ? regexMatch[2]! : regexMatch[2]! + "i";
        hit = new RegExp(regexMatch[1]!, flags);
      } catch {
        hit = null;
      }
    }
    if (userRegexCache.size >= PATTERN_CACHE_MAX) userRegexCache.clear();
    userRegexCache.set(keyword, hit);
  }
  return hit;
}
