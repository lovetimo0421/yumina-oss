/**
 * Values a card's code or engine matches literally, and the text formats its interface parses.
 *
 * Audit of 400 AI-translated versions (2026-11-21): 98 broke while the prose read fine, because the
 * translator rewrote such values. The old protection only knew `=== "x"` / `case "x"` literals and rule
 * values; it missed:
 *  - keys of lookup maps (`EMOTION_ASSETS["Neutral"]`, `moodColors: { Smug: … }`, `PORTRAITS.BROOKE.smile`),
 *    so "Smug, Scheming" in a mood variable's rules became 得意、算计 and the panel never matched;
 *  - substring scans (`scene.indexOf("Bath")`, `recent.includes("Critical")`);
 *  - variable options and the keys of JSON defaults (`{ "goals": [] }` -> 목표);
 *  - markers the interface splits replies on: `【Bella】`, `<face>smile</face>`, `[状态|…]`,
 *    a ``` fence around `[Status Panel]`, `Tsunade: 「…」`, `**NIGHT 1**`, `Emotion: Neutral`.
 * Russian batch (2026-11-21) added:
 *  - keyword regexes the code tests a variable's value with (`{ key: 'foot', match: /foot|end of the bed|bedside/i }`
 *    then `p.match.test(distance)`): the variable's listed values ("Doorway / foot of the bed / edge of the bed")
 *    are code-matched like `=== "x"`, though no single literal spells them;
 *  - a dialogue-quote format (/^(.*?)「(.+?)」(.*)/) matched whole short lines, which then went to the model as
 *    "markers to copy byte for byte", so four 「…」 lines came back in English. A marker is now the match with its
 *    free-text groups cut out (「…」), and a restore never writes a sentence of the source back.
 * This module finds those values and formats, checks a translation against them, and restores the
 * markers deterministically when a retry still loses them.
 *
 * The patterns come from the card's own code, so any of them can backtrack for minutes on the wrong text
 * (/^【(\w|\w)*】$/ on a long unclosed bracket). translateCard runs everything that evaluates them in a worker
 * (card-translate-regex/), which times each evaluation through `patternClock` and drops a pattern that runs too
 * long; riskyPattern() rejects the obvious shapes before they are even compiled.
 */
import { parse } from "@babel/parser";

/**
 * Every evaluation of a card-author pattern is wrapped in enter/leave, keyed by the pattern's source. A no-op on
 * the main thread; the worker that runs them points it at shared memory, so the server can see which pattern is
 * running and for how long, and stop it.
 */
export const patternClock: { enter(key: string): void; leave(): void } = { enter() {}, leave() {} };
const timed = <T>(re: RegExp, fn: () => T): T => {
  patternClock.enter(re.source);
  try { return fn(); } finally { patternClock.leave(); }
};

/** Longest card pattern considered at all; anything longer is not a format a card's interface parses. */
export const MAX_PATTERN_LENGTH = 1000;

/**
 * Shapes whose backtracking explodes on text that almost matches: a repeated group whose body is nothing but
 * repeats ((a+)+, (\w+\s?)*, (x*y?)*), or a repeated backreference. A repeated group with something matched
 * exactly once in every branch ((?:\[[^\]]+\]\s*)+, (?:\.\w+)*) is left alone: that is what card formats look
 * like, and most are linear. What this lets through (ambiguous alternations like (\w|\w)*) the worker's clock stops.
 */
export function riskyPattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return true;
  type Node = { unbounded: boolean; fixed: boolean; backref: boolean };
  let i = 0, risky = false;
  const quantifier = (): { unbounded: boolean; min: number } | null => {
    const c = pattern[i];
    let q: { unbounded: boolean; min: number } | null = null;
    if (c === "*") { q = { unbounded: true, min: 0 }; i++; }
    else if (c === "+") { q = { unbounded: true, min: 1 }; i++; }
    else if (c === "?") { q = { unbounded: false, min: 0 }; i++; }
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (!m) return null;
      const min = Number(m[1]), max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min;
      q = { unbounded: max > 10, min }; i += m[0].length;
    }
    if (q && pattern[i] === "?") i++; // lazy
    return q;
  };
  const atom = (): Node => {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[i + 1] ?? ""; i += 2;
      if (/[1-9]/.test(n)) { while (/\d/.test(pattern[i] ?? "")) i++; return { unbounded: false, fixed: false, backref: true }; }
      if (n === "k" && pattern[i] === "<") { i = Math.max(i, pattern.indexOf(">", i) + 1); return { unbounded: false, fixed: false, backref: true }; }
      if (n === "u" || n === "x") { while (/[0-9a-fA-F{}]/.test(pattern[i] ?? "")) i++; return { unbounded: false, fixed: true, backref: false }; }
      if (n === "p" || n === "P") { if (pattern[i] === "{") i = Math.max(i, pattern.indexOf("}", i) + 1); return { unbounded: false, fixed: true, backref: false }; }
      // \b and \B are anchors; every other escape matches one character.
      return { unbounded: false, fixed: n !== "b" && n !== "B", backref: false };
    }
    if (c === "[") {
      i++;
      if (pattern[i] === "^") i++;
      if (pattern[i] === "]") i++;
      while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      i++;
      return { unbounded: false, fixed: true, backref: false };
    }
    if (c === "(") {
      i++;
      let look = false;
      if (pattern[i] === "?") {
        const head = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(pattern.slice(i))?.[0] ?? "?";
        look = head === "?=" || head === "?!" || head === "?<=" || head === "?<!";
        i += head.length;
      }
      const inner = alternation();
      if (pattern[i] === ")") i++;
      return look ? { unbounded: false, fixed: false, backref: false } : inner; // a lookaround consumes nothing
    }
    i++;
    if (c === "^" || c === "$") return { unbounded: false, fixed: false, backref: false };
    return { unbounded: false, fixed: true, backref: false };
  };
  const sequence = (): Node => {
    const out: Node = { unbounded: false, fixed: false, backref: false };
    while (i < pattern.length && pattern[i] !== "|" && pattern[i] !== ")" && !risky) {
      const a = atom();
      const q = quantifier();
      if (q?.unbounded && ((a.unbounded && !a.fixed) || a.backref)) risky = true;
      out.unbounded ||= a.unbounded || !!q?.unbounded;
      // Something matched exactly once anchors a repetition (not the x of x+, nor an optional y?).
      out.fixed ||= a.fixed && (!q || (!q.unbounded && q.min > 0));
      out.backref ||= a.backref;
    }
    return out;
  };
  const alternation = (): Node => {
    const first = sequence();
    const out = { ...first };
    while (pattern[i] === "|" && !risky) {
      i++;
      const b = sequence();
      out.unbounded ||= b.unbounded; out.backref ||= b.backref; out.fixed &&= b.fixed;
    }
    return out;
  };
  while (i < pattern.length && !risky) { alternation(); if (pattern[i] === ")") i++; }
  return risky;
}

export interface MarkerPattern {
  re: RegExp;
  /** Literal words the pattern spells ("Bella", "Status Panel", "时间"): a line only counts when it carries one. */
  words: string[];
  src: string;
  /** Spans lines (`[\s\S]*?`), so it is checked on the whole text rather than line by line. */
  multiline: boolean;
}

export interface CardLiterals {
  /** Strings compared, scanned for, used as option values or as rule values. */
  values: Set<string>;
  /** Keys of lookup maps in the interface code and of JSON variable defaults. */
  keys: Set<string>;
  /** Formats the interface parses out of messages. */
  patterns: MarkerPattern[];
  /** Keyword regexes (not formats) the code tests text or variable values with: /near|close/i. */
  scans: RegExp[];
  /**
   * Values a variable's rules list that one of those regexes reads ("foot of the bed"). The narrator must write
   * them as they are, but no code literal spells them, so an interface label with the same words stays free.
   */
  listed: Set<string>;
}

const MATCH_METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "has", "get", "split", "replace", "replaceAll"]);
const SKIP_KEYS = new Set(["loc", "start", "end", "extra", "comments", "leadingComments", "trailingComments", "innerComments"]);
/** Lines no format marker should match: a pattern that does is generic text handling, not a format. */
const GENERIC_LINES = ["", "a b c", "She walks slowly to the door, then smiles at you.", "The rain keeps falling.", "그녀는 천천히 문으로 걸어가 미소 짓는다.", "她慢慢走到门口，对你微笑。", "*She looks away.*", "Dia berjalan pelan ke pintu.", "\"Hello there,\" she says.", "“안녕,” 그녀가 말한다.", "Write in English.", "- item one", "## Heading", "Name: value"];

const walk = (node: any, fn: (n: any, parent: any) => void, parent: any = null): void => {
  if (!node || typeof node.type !== "string") return;
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn, node));
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, fn, node);
  }
};

export function codeFiles(schema: Record<string, any>): string[] {
  const out: string[] = [];
  for (const v of Object.values(schema.rootComponent?.files ?? {})) out.push(typeof v === "string" ? v : (v as any)?.content ?? "");
  for (const c of Array.isArray(schema.customComponents) ? schema.customComponents : []) if (typeof c?.tsxCode === "string") out.push(c.tsxCode);
  if (typeof schema.messageRenderer?.tsxCode === "string") out.push(schema.messageRenderer.tsxCode);
  return out.filter(Boolean);
}

/** Words a regex spells literally, ignoring classes and escapes: /^(?:【Bella】|\[Bella\])/ -> ["Bella", "Bella"]. */
export function literalWords(pattern: string): string[] {
  return pattern.replace(/\\[sSdDwWbBnrtfv]/g, " ").replace(/\[(?:\\.|[^\]])*\]/g, " ").replace(/\\u[0-9a-fA-F]{4}/g, " ").replace(/\\(.)/g, "$1")
    .match(/[A-Za-z]{2,}|[぀-ヿ一-鿿가-힯]{2,}|[Ѐ-ӿ]{2,}/g) ?? [];
}

/** A pattern describing a format (brackets, tags, labels with colons, quotes), not a list of prose keywords. */
export function isFormatPattern(pattern: string): boolean {
  const q = pattern.replace(/\(\?(?:[:=!]|<[=!])/g, "(").replace(/\[\^/g, "[");
  if (/^[\w\s|()?*+.'-]+$/.test(q.replace(/\\[bswd]/gi, ""))) return false;
  return /[【】<>:：「」"“”『』■]|\\\[|\\\]/.test(q) || (q.startsWith("^") && literalWords(pattern).some((w) => w.length >= 3));
}

const TEST_METHODS = new Set(["test", "exec"]);
const TESTED_BY_METHODS = new Set(["match", "matchAll", "search"]);

/** A regex that lists words to look for (/near|close/i, /\b(door|hall)\b/), as opposed to a format or a character class. */
export function isKeywordPattern(pattern: string): boolean {
  return !isFormatPattern(pattern) && literalWords(pattern).some((w) => w.length >= 3 || /[^\x00-\x7f]/.test(w));
}

function scanCode(code: string, lit: CardLiterals, skip: PatternSkip): void {
  let ast: any;
  try { ast = parse(code, { sourceType: "module", plugins: ["jsx", "typescript"], errorRecovery: true }); } catch { return; }
  const keyName = (p: any) => p.key?.type === "Identifier" ? p.key.name : p.key?.type === "StringLiteral" ? p.key.value : null;
  // Names a regex is held under and then run against text: `RE.test(t)`, `p.match.test(distance)`, `t.match(RE)`.
  // A regex literal stored under such a name (a const, an object field) is a scan; so is one used in place.
  const tested = new Set<string>();
  const nameOf = (x: any): string | null => x?.type === "Identifier" ? x.name : x?.type === "MemberExpression" && !x.computed ? x.property?.name ?? null : null;
  const direct = new Set<any>();
  walk(ast.program, (n) => {
    if (n.type !== "CallExpression" || n.callee?.type !== "MemberExpression") return;
    const m = n.callee.property?.name;
    if (TEST_METHODS.has(m)) { const o = n.callee.object; if (o?.type === "RegExpLiteral" || o?.type === "NewExpression") direct.add(o); else { const k = nameOf(o); if (k) tested.add(k); } }
    if (TESTED_BY_METHODS.has(m)) { const a = n.arguments?.[0]; if (a?.type === "RegExpLiteral" || a?.type === "NewExpression") direct.add(a); else { const k = nameOf(a); if (k) tested.add(k); } }
  });
  const addScan = (pattern: string, flags: string) => {
    const f = flags.replace(/[gy]/g, "");
    if (skip.all || !isKeywordPattern(pattern) || lit.scans.some((r) => r.source === pattern && r.flags === f) || riskyPattern(pattern)) return;
    let re: RegExp;
    try { re = new RegExp(pattern, f); } catch { return; /* not a JS regex */ }
    if (!skip.sources?.has(re.source)) lit.scans.push(re);
  };
  const regexOf = (x: any): [string, string] | null => x?.type === "RegExpLiteral" ? [x.pattern, x.flags] : x?.type === "NewExpression" && x.callee?.name === "RegExp" && x.arguments?.[0]?.type === "StringLiteral" ? [x.arguments[0].value, x.arguments[1]?.value ?? ""] : null;
  walk(ast.program, (n) => {
    const r = regexOf(n);
    if (r && direct.has(n)) addScan(r[0], r[1]);
    if (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && tested.has(n.id.name)) { const x = regexOf(n.init); if (x) addScan(x[0], x[1]); }
    if (n.type === "ObjectProperty" && !n.computed && tested.has(keyName(n))) { const x = regexOf(n.value); if (x) addScan(x[0], x[1]); }
  });
  walk(ast.program, (n, parent) => {
    if (n.type === "StringLiteral" && parent) {
      if (parent.type === "BinaryExpression" && ["===", "!==", "==", "!="].includes(parent.operator)) lit.values.add(n.value);
      else if (parent.type === "SwitchCase" && parent.test === n) lit.values.add(n.value);
      else if (parent.type === "CallExpression" && parent.callee?.type === "MemberExpression" && MATCH_METHODS.has(parent.callee.property?.name) && parent.arguments[0] === n) lit.values.add(n.value);
      else if (parent.type === "MemberExpression" && parent.computed && parent.property === n) lit.keys.add(n.value);
    }
    if (n.type === "RegExpLiteral") addPattern(lit, n.pattern, n.flags, skip);
    if (n.type === "NewExpression" && n.callee?.name === "RegExp" && n.arguments?.[0]?.type === "StringLiteral") addPattern(lit, n.arguments[0].value, n.arguments[1]?.value ?? "", skip);
    // Lookup maps: keyed by names / states (capitalised or non-identifier keys), holding assets, or a CONSTANT.
    if (n.type === "ObjectExpression") {
      const props = n.properties.filter((p: any) => p.type === "ObjectProperty" && !p.computed);
      const names = props.map(keyName).filter((k: string | null): k is string => !!k);
      const assets = props.filter((p: any) => p.value?.type === "StringLiteral" && /^(@asset|https?:|\/|data:)/.test(p.value.value)).length;
      const capsKeys = names.filter((k: string) => /^[A-Z]/.test(k) || /[^\w$]/.test(k)).length;
      if (names.length >= 2 && (assets >= Math.max(1, names.length / 2) || capsKeys >= names.length * 0.6)) names.forEach((k: string) => lit.keys.add(k));
    }
    if (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && /^[A-Z][A-Z0-9_]{2,}$/.test(n.id.name) && n.init?.type === "ObjectExpression") {
      for (const p of n.init.properties) if (p.type === "ObjectProperty" && !p.computed) { const k = keyName(p); if (k) lit.keys.add(k); }
    }
  });
}

/** Card patterns to leave out: all of them, or those (by RegExp source) that already ran too long in this job. */
export interface PatternSkip { all?: boolean; sources?: ReadonlySet<string> }

function addPattern(lit: CardLiterals, pattern: string, flags: string, skip: PatternSkip): void {
  if (skip.all || lit.patterns.some((p) => p.src === `/${pattern}/${flags}`) || riskyPattern(pattern)) return;
  let re: RegExp;
  try { re = new RegExp(pattern, flags.replace(/[gy]/g, "")); } catch { return; }
  if (skip.sources?.has(re.source) || !isFormatPattern(pattern) || timed(re, () => GENERIC_LINES.some((g) => re.test(g)))) return;
  // Spans lines: an explicit \n, or "anything" between two markers without a line anchor
  // (```[\s\S]*?\[Status Panel\]...```). /^【Bella】\s*([\s\S]*)$/ is still a one-line format.
  const multiline = /\\n/.test(pattern) || flags.includes("s") || (/\[\\s\\S\]|\[\^[^\]]*\]\*/.test(pattern) && !pattern.startsWith("^"));
  lit.patterns.push({ re, words: literalWords(pattern), src: `/${pattern}/${flags}`, multiline });
}

/**
 * The values a variable's text lists ("Doorway / foot of the bed / edge of the bed", "one of: calm, wary or
 * afraid", a quoted "near"). A sentence that merely uses a word is not a list.
 */
export function listedValues(text: string): string[][] {
  const groups: string[][] = [];
  const clean = (x: string) => x.trim().replace(/^["'`“‘«]+|["'`”’»]+$/g, "").replace(/[.!?。！？]+$/, "").trim();
  const short = (x: string) => x.length >= 2 && x.length <= 40 && x.split(/\s+/).length <= 6 && /[\p{L}]/u.test(x);
  const quoted = [...text.matchAll(/["“«]([^"”»\n]{2,40})["”»]|(?<![\p{L}])'([^'\n]{2,40})'(?![\p{L}])/gu)].map((m) => clean(m[1] ?? m[2] ?? "")).filter(short);
  if (quoted.length) groups.push([...new Set(quoted)]);
  const noParens = text.replace(/\([^()\n]*\)|（[^（）\n]*）/g, " ");
  for (const clause of noParens.split(/\n|;|[.!?。！？](?:\s+|$)|[:：]\s*/)) {
    const parts = clause.split(/\s*(?:\/|\||,|、|→|->|\bor\b|\band\b|(?<![\p{L}])(?:или|и)(?![\p{L}]))\s*/u).map(clean).filter(Boolean);
    if (parts.length >= 2 && parts.every(short)) groups.push(parts);
  }
  return groups;
}

/** A keyword regex hits a value where a match starts a word ("door" in "Doorway"), not mid-word ("neve" in "whenever"). */
const hitsValue = (re: RegExp, value: string) => timed(re, () => {
  const g = new RegExp(re.source, re.flags.replace(/[gy]/g, "") + "g");
  for (const m of value.matchAll(g)) if (m[0] && !/[\p{L}\p{N}_]/u.test(value[m.index! - 1] ?? "")) return true;
  return false;
});

export function cardLiterals(schema: Record<string, any>, skip: PatternSkip = {}): CardLiterals {
  const lit: CardLiterals = { values: new Set(), keys: new Set(), patterns: [], scans: [], listed: new Set() };
  for (const code of codeFiles(schema)) scanCode(code, lit, skip);
  // A variable whose value the code tests with a keyword regex: the values its rules list, which that regex
  // reads, are matched by the code as surely as a `=== "x"` (the narrator must write them as they are).
  // A list counts when at least two of its items are hit (one hit is a word that happens to match: "quidditch"
  // in a list of outfits, tested by the code's place regex).
  if (lit.scans.length) for (const v of Array.isArray(schema.variables) ? schema.variables : []) {
    if (v?.type !== "string") continue;
    let found = false;
    for (const group of listedValues(`${v.description ?? ""}\n${v.behaviorRules ?? ""}`)) {
      const hit = group.filter((x) => lit.scans.some((re) => hitsValue(re, x)));
      if (hit.length >= 2) { hit.forEach((x) => lit.listed.add(x)); found = true; }
    }
    if (found && typeof v.defaultValue === "string" && v.defaultValue.length <= 40 && lit.scans.some((re) => hitsValue(re, v.defaultValue))) lit.listed.add(v.defaultValue);
  }
  // A compared marker ("[WAKE-UP UNREAD DUMP", "【System】") works like a pattern too.
  for (const v of lit.values) if (/[【\[<「]/.test(v) && v.length >= 3 && v.length <= 40 && /[A-Za-z一-鿿가-힯Ѐ-ӿ]{2,}/.test(v)) {
    lit.patterns.push({ re: new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), words: [v.replace(/[【】\[\]<>「」\/]/g, "")], src: JSON.stringify(v), multiline: false });
  }
  for (const v of Array.isArray(schema.variables) ? schema.variables : []) {
    for (const o of Array.isArray(v.options) ? v.options : []) { const x = typeof o === "string" ? o : o?.value ?? o?.id; if (typeof x === "string") lit.values.add(x); }
    if (v.type === "json") jsonKeys(v.defaultValue, lit.keys);
  }
  const ruleValues = (o: any): void => { if (Array.isArray(o)) o.forEach(ruleValues); else if (o && typeof o === "object") { if (typeof o.value === "string" && o.value.length < 40) lit.values.add(o.value); Object.values(o).forEach(ruleValues); } };
  ruleValues(schema.rules ?? []); ruleValues(schema.reactions ?? []);
  return lit;
}

function jsonKeys(v: unknown, out: Set<string>, depth = 0): void {
  if (!v || typeof v !== "object" || depth > 3) return;
  for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v) && !/^\d+$/.test(k)) out.add(k); jsonKeys(x, out, depth + 1); }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w: string, flags = "") => new RegExp(/^\w/.test(w) && /\w$/.test(w) ? `(?<![A-Za-z0-9_])${esc(w)}(?![A-Za-z0-9_])` : esc(w), flags);
const STOP = /^(to|at|by|from|of|on|in|up|no|yes|and|or|the|a|an|is|be|it|you|me|he|she|they|we|with|when|then|after|before|what|who|where|only|one|once|now|has|was|set|use|other|next|last|back|line|row|rows|lines|string|number|object|body|raw|player|time|turn|turns|current|start|day|days|count|change|changes|changed|reason|source|file|map|content|summary|story|role|kind|side|item|public|selected|active|valid|detail|record|records|event|events|level|status|name|names|type|value|text|label|title|id|key|default|true|false|null|new|all|any|none|off|for|that|this|are|its|may|how|why|because|known|far|note|exact|writes|knows|later|since|full|first)$/i;

/** Literals worth guarding in prose: a real word or id, not a one-letter grade or a common English word. */
export function guardable(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((x) => typeof x === "string" && x.length >= 2 && x.length <= 40 && /[A-Za-z぀-ヿ一-鿿가-힯Ѐ-ӿ]/.test(x) && !STOP.test(x) && !/^[#.\/@]/.test(x));
}

/**
 * Values the source writes as values (a list "Calm, Wary, Aroused", quoted, an id, or assigned to a variable:
 * "set scene to rite") that the translation no longer contains. A name or word merely used in prose does not
 * count: DanMachi's Russian rules got 25 notes like "write these untranslated: off, floor, next, where" because
 * every code-scanned word the rules happened to use was pinned, which pushes English into the story.
 * `onlyAssigned`: the text belongs to a number or boolean variable, which has no text values of its own; only a
 * value it tells the narrator to give another variable counts.
 */
export function lostValues(src: string, out: string, candidates: Iterable<string>, opts: { ids?: Iterable<string>; onlyAssigned?: boolean } = {}): string[] {
  const present = guardable(candidates).filter((x) => wordRe(x).test(src));
  const SEP = String.raw`["'”’)]?\s*(?:,|、|/|\||;|\bor\b|\band\b|->|→)\s*["'“‘(]?`;
  const listed = (x: string) => present.some((y) => y !== x && (new RegExp(esc(x) + SEP + esc(y)).test(src) || new RegExp(esc(y) + SEP + esc(x)).test(src)));
  const quoted = (x: string) => new RegExp("[\"'`“‘]" + esc(x) + "[\"'`”’]").test(src);
  const idLike = (x: string) => /^[A-Z][A-Z0-9_]{2,}$/.test(x) || /^[a-z0-9]+[_-][a-z0-9_-]+$/.test(x);
  // "set scene to rite", "scene to dungeon", "mood = calm", "[mood: set calm]": a value given to a variable.
  const ids = [...(opts.ids ?? [])].filter(Boolean).map(esc).join("|");
  const target = ids ? `(?:it|${ids})` : String.raw`[\w.-]+`;
  const assigned = (x: string) => new RegExp(String.raw`(?:\bset\s+${target}\s+(?:to|as|=)\s*|${ids ? String.raw`\b(?:${ids})\s+to\s+|\[(?:${ids})\s*:\s*(?:set\s+)?|` : ""}\b(?:${ids || "(?!)"})\s*=\s*)["'“‘]?${esc(x)}(?![\w-])`, "i").test(src);
  return present.filter((x) => (opts.onlyAssigned ? assigned(x) : listed(x) || quoted(x) || idLike(x) || assigned(x)) && !wordRe(x, "i").test(out));
}

/** Patterns that match fewer lines (or whole-text blocks) after translation than before. */
export function lostPatterns(src: string, out: string, patterns: MarkerPattern[], opening: boolean): MarkerPattern[] {
  const sl = src.split("\n"), tl = out.split("\n");
  const relevant = (p: MarkerPattern, line: string) => opening || p.words.some((w) => w.length >= 2 && line.includes(w));
  return patterns.filter((p) => timed(p.re, () => {
    if (p.multiline) { const g = new RegExp(p.re.source, p.re.flags + "g"); return (src.match(g) ?? []).length > (out.match(g) ?? []).length && (opening || p.words.some((w) => src.includes(w))); }
    const a = sl.filter((l) => p.re.test(l) && relevant(p, l)).length;
    return a > 0 && tl.filter((l) => p.re.test(l)).length < a;
  }));
}

const BRACKETS: Array<[string, string]> = [["【", "】"], ["[", "]"], ["<", ">"], ["「", "」"], ["『", "』"], ["〔", "〕"]];

/**
 * Bracketed markers in a text whose name one of the code's patterns spells, with the same bracket:
 * "【Bella】" when a pattern reads /^【(?:Bella|Luna)】/, "[状态" for /\[状态\|…\]/.
 */
export function markerTokens(text: string, patterns: MarkerPattern[]): string[] {
  const out = new Set<string>();
  for (const [o, c] of BRACKETS) {
    const pats = patterns.filter((p) => p.src.includes(o) || p.src.includes("\\" + o));
    if (!pats.length) continue;
    const words = new Set(pats.flatMap((p) => p.words).filter((w) => w.length >= 2));
    for (const line of text.split("\n")) for (const t of tokens(line, o, c)) {
      const head = headOf(t.inner).trim();
      if (!head || !words.has(head.replace(/^\//, "")) && !head.split(/\s+/).every((w) => words.has(w))) continue;
      out.add(head === t.inner ? o + head + c : o + head);
    }
  }
  return [...out];
}

/** Three or more words in a row: a sentence, not a marker. */
const SENTENCE = /[\p{L}\p{N}'’-]+[\s,]+[\p{L}\p{N}'’-]+[\s,]+[\p{L}\p{N}'’-]+/u;
const FREE_TEXT = (x: string) => /\s/.test(x.trim()) || x.length > 20 || /[.!?。！？…]/.test(x);

/**
 * The marker part of a line a pattern matches: the match with its free-text groups cut out. /^(.*?)「(.+?)」(.*)/
 * on "「…You have the scent of mana about you.」" gives "「…」", not the sentence; /^【(Bella|Luna)】/ still gives
 * "【Bella】" and /<face>([a-z_]+)<\/face>/ "<face>smile</face>". Null when what is left is still a sentence.
 */
export function markerOf(line: string, p: MarkerPattern): string | null {
  let re: RegExp;
  try { re = new RegExp(p.re.source, p.re.flags.replace(/[gyd]/g, "") + "d"); } catch { return null; }
  const m = timed(p.re, () => re.exec(line)) as (RegExpExecArray & { indices?: Array<[number, number] | undefined> }) | null;
  if (!m) return null;
  const [s0] = m.indices![0]!;
  let out = m[0];
  // Speech inside a quote bracket is free text however short ("「Oh—」"); so is anything with spaces or a sentence.
  const speech = (r: [number, number]) => /[「『“"«]/.test(line[r[0] - 1] ?? "") || /[」』”"»]/.test(line[r[1]] ?? "");
  const groups = (m.indices ?? []).slice(1).map((r, i) => ({ r, text: m[i + 1] }))
    .filter((g): g is { r: [number, number]; text: string } => !!g.r && typeof g.text === "string" && g.text.length > 0 && (FREE_TEXT(g.text) || speech(g.r)))
    .sort((a, b) => b.r[0] - a.r[0]);
  let last = Infinity;
  for (const g of groups) {
    if (g.r[1] > last) continue; // nested inside a group already cut
    out = out.slice(0, g.r[0] - s0) + "…" + out.slice(g.r[1] - s0); last = g.r[0];
  }
  // Free text at either end is just the rest of the line ("【Bella】…" is "【Bella】").
  out = out.replace(/…+/g, "…").replace(/^[…\s]+|[…\s]+$/g, "");
  if (out.replace(/[…\s]/g, "").length < 1 || SENTENCE.test(out)) return null;
  return out;
}

/**
 * The markers as they appear in a card's texts (【Bella】, <face>smile</face>, [Status Panel]), at most `max`, for
 * the translator to copy: the marker part of each line a pattern matches, then bracket heads the patterns spell.
 */
export function formatMarkers(texts: Array<{ text: string; facing: boolean }>, patterns: MarkerPattern[], max = 40): string[] {
  const markers = new Set<string>();
  for (const { text, facing } of texts) {
    for (const line of text.split("\n")) for (const p of patterns) {
      if (p.multiline || markers.size >= max) continue;
      // The marker part only (「…」 of a quoted line): a whole short line listed here was copied untranslated.
      const m = markerOf(line, p);
      if (m && m.length >= 2 && m.length <= 40 && (facing || p.words.some((w) => line.includes(w)))) markers.add(m);
    }
  }
  for (const { text } of texts) for (const m of markerTokens(text, patterns)) if (markers.size < max) markers.add(m);
  return [...markers];
}

/** A short line of the source a pattern matches, to show the translator what was lost. */
export function patternSample(src: string, p: MarkerPattern): string | undefined {
  return timed(p.re, () => src.split("\n").map((l) => l.match(p.re)?.[0]).find((m): m is string => !!m && m.length <= 40));
}

/** Markers the source carries that the translation dropped. */
export function lostMarkers(src: string, out: string, patterns: MarkerPattern[]): string[] {
  return markerTokens(src, patterns).filter((m) => !out.includes(m));
}

// ---------------------------------------------------------------------------
// Deterministic restore: put the source's markers back into translated lines, keeping the translated words.

const tokens = (line: string, o: string, c: string) => {
  const out: Array<{ s: number; e: number; inner: string }> = [];
  for (let i = line.indexOf(o); i >= 0; i = line.indexOf(o, i + 1)) {
    const j = line.indexOf(c, i + 1);
    if (j < 0 || j - i > 80) continue;
    out.push({ s: i, e: j + 1, inner: line.slice(i + 1, j) }); i = j;
  }
  return out;
};
/** The marker part of a bracket: "System Notice" of 【System Notice · Welcome】, "状态" of [状态|…|…]. */
const headOf = (inner: string) => inner.match(/^(\/?[^|:：·]*?)(\s*[|:：·].*)?$/s)?.[1] ?? inner;

/** Brackets that hold speech in quoted-dialogue formats: what is inside them is prose, not a marker. */
const QUOTE_BRACKETS = new Set(["「", "『"]);

/**
 * Put the source's bracket heads back. Only a head that is a marker is restored: a word the code's patterns
 * spell, or a short label ("Status Panel"). The contents of 「…」 speech, or any sentence, stay translated.
 */
function bracketRestore(s: string, t: string, words: ReadonlySet<string> = new Set()): string | null {
  let out = t, changed = false;
  const named = (h: string) => { const x = h.trim().replace(/^\//, ""); return !!x && (words.has(x) || x.split(/\s+/).every((w) => words.has(w))); };
  const label = (h: string) => { const x = h.trim(); return x.length <= 30 && x.split(/\s+/).length <= 3 && !/[.!?。！？…,，]/.test(x); };
  for (const [o, c] of BRACKETS) {
    const a = tokens(s, o, c), b = tokens(out, o, c);
    if (!a.length || a.length !== b.length) continue;
    for (let k = b.length - 1; k >= 0; k--) {
      const ha = headOf(a[k]!.inner), hb = headOf(b[k]!.inner);
      if (ha === hb || !ha.trim()) continue;
      if (!named(ha) && (QUOTE_BRACKETS.has(o) || !label(ha))) continue;
      out = out.slice(0, b[k]!.s + 1) + ha + out.slice(b[k]!.s + 1 + hb.length); changed = true;
    }
  }
  return changed ? out : null;
}
function quoteRestore(s: string, t: string): string | null {
  // Russian and Spanish models write «…» for 「…」 too; every quoted span on the line goes back, words kept.
  if (s.includes("「") && !t.includes("「") && /[“"«]/.test(t)) return t.replace(/[“"«]([^”"»\n]*)[”"»]/g, "「$1」");
  if (s.includes('"') && !/[“”]/.test(s) && /[“”]/.test(t)) return t.replace(/[“”]/g, '"');
  if (/[“”]/.test(s) && !s.includes('"') && t.includes('"')) { let k = 0; return t.replace(/"/g, () => (k++ % 2 ? "”" : "“")); }
  return null;
}
const LABEL = /^(\s*[-*•>#]*\s*)([^:：\n"“「]{1,40}?)(\s*[:：])/;
function labelRestore(s: string, t: string): string | null {
  const a = s.match(LABEL), b = t.match(LABEL);
  if (!a || !b || a[2] === b[2]) return null;
  return t.replace(LABEL, (b[1] ?? "") + (a[2] ?? "") + (a[3] ?? ""));
}
function tagSpanRestore(s: string, t: string): string | null {
  const re = /<([^<>\s\/]{1,20})>([^<>\n]{0,40})<\/\1>/g;
  const a = [...s.matchAll(re)], b = [...t.matchAll(re)];
  if (!a.length || a.length !== b.length) return null;
  let out = t, changed = false;
  for (let k = b.length - 1; k >= 0; k--) {
    if (!/^[\w\s.-]{1,30}$/.test(a[k]![2]!) || a[k]![0] === b[k]![0]) continue;
    out = out.slice(0, b[k]!.index) + a[k]![0] + out.slice(b[k]!.index! + b[k]![0].length); changed = true;
  }
  return changed ? out : null;
}
function delimRestore(s: string, t: string): string | null {
  let out = t, changed = false;
  for (const re of [/\*\*([^*\n]{1,60})\*\*/g, /■([^■\n]{1,60})■/g]) {
    const a = [...s.matchAll(re)], b = [...out.matchAll(re)];
    if (!a.length || a.length !== b.length) continue;
    for (let k = b.length - 1; k >= 0; k--) {
      if (!/^[\x20-\x7e]+$/.test(a[k]![1]!) || a[k]![1] === b[k]![1]) continue;
      out = out.slice(0, b[k]!.index) + a[k]![0] + out.slice(b[k]!.index! + b[k]![0].length); changed = true;
    }
  }
  return changed ? out : null;
}

const WSTOP = /^(and|the|of|or|to|in|on|at|is|be|as|by|for|with|from|not|no|but|if|so|then|when|while|this|that|it|you|he|she|they|we|a|an|s|i)$/i;
const runs = (x: string) => x.match(/[A-Za-z_][A-Za-z0-9_]*|[぀-ヿ一-鿿]+|[Ѐ-ӿ]+/g) ?? [];

/** Repair one translated line so every pattern the source line matched matches again. */
export function restoreLine(s: string, t: string, patterns: MarkerPattern[], opening: boolean): string | null {
  const ok = (x: string) => patterns.every((p) => timed(p.re, () => p.re.test(x)));
  const spelled = new Set(patterns.flatMap((p) => p.words));
  const steps = [(a: string, b: string) => bracketRestore(a, b, spelled), quoteRestore, labelRestore, tagSpanRestore, delimRestore];
  const tries: number[][] = [[0], [1], [2], [3], [4], [0, 1], [0, 2], [1, 2], [0, 1, 2], [3, 1], [0, 3]];
  const words = patterns.flatMap((p) => p.words).filter((w) => !WSTOP.test(w) && (w.length >= 3 || /[^\x00-\x7f]/.test(w))).map((w) => w.toLowerCase());
  const isMarkerWord = (w: string) => words.some((x) => w.toLowerCase() === x || (x.length >= 3 && w.toLowerCase().includes(x)));
  for (const order of tries) {
    let y = t; const used: number[] = [];
    for (const i of order) { const z = steps[i]!(s, y); if (z != null) { y = z; used.push(i); } }
    if (y === t || !ok(y)) continue;
    // Keep it only when it puts back a word the pattern spells (or, in an opening, only brackets/quotes
    // changed): a pattern with no words of its own cannot justify relabelling a translated line.
    const have = new Set(runs(t)), back = runs(y).filter((w) => !have.has(w));
    // A restore puts back markers, never the source's prose: a repair that writes back more than a few
    // source words the pattern does not spell is copying the untranslated line, and is dropped.
    if (back.filter((w) => !isMarkerWord(w)).length > 3) continue;
    const marker = back.some(isMarkerWord);
    const relabels = used.includes(2);
    if (relabels ? marker && patterns.some((p) => back.some((w) => p.src.includes(w + ":") || p.src.includes(w + "：") || p.src.includes(w + "[") || p.src.includes(w + "\\s"))) : marker || opening) return y;
  }
  return null;
}

/**
 * Restore markers across a whole text: a dropped ``` fence, `Label: value` slots whose value the code
 * looks up in a map, then line by line where source and translation still align. Only marker tokens go
 * back into a translated line; a source line is never copied over its translation.
 */
export function restoreMarkers(src: string, out: string, lit: CardLiterals, opening: boolean): { text: string; restored: number } {
  let text = out, restored = 0;
  const lost = lostPatterns(src, text, lit.patterns, opening);
  if (lost.some((p) => p.multiline)) {
    const first = src.trimStart().split("\n")[0]!, last = src.trimEnd().split("\n").pop()!;
    let t = text;
    if (/^```/.test(first) && !/^```/.test(t.trimStart())) t = first + "\n" + t.trimStart();
    if (/^```\s*$/.test(last) && !/```\s*$/.test(t.trimEnd())) t = t.trimEnd() + "\n" + last;
    if (t !== text) { text = t; restored++; }
  }
  // "Emotion: 중립" -> "Emotion: Neutral" when the code keys a map by the source value.
  const LV = /^(\W{0,4})([A-Za-z][\w ]{0,30}?)\s*:\s*([^,.\n]{1,40})/;
  const tl = text.split("\n"), seen = new Map<string, number>();
  for (const line of src.split("\n")) {
    const m = line.match(LV); if (!m) continue;
    const label = m[2]!, val = m[3]!.trim();
    if (!lit.keys.has(val)) continue;
    const nth = seen.get(label) ?? 0; seen.set(label, nth + 1);
    let k = -1;
    for (let j = 0; j < tl.length; j++) {
      const tm = tl[j]!.match(LV);
      if (!tm || tm[2] !== label || ++k !== nth) continue;
      const tv = tm[3]!.trim();
      if (tv !== val && !lit.keys.has(tv) && !/^[("'“\[<]/.test(tv) && tv.length <= 25 && /[^\x00-\x7f]/.test(tv)) { tl[j] = tl[j]!.replace(LV, (all, _a, _b, c: string) => all.replace(c.trim(), val)); restored++; }
      break;
    }
  }
  text = tl.join("\n");
  const sl = src.split("\n"), ol = text.split("\n");
  if (sl.length === ol.length) {
    for (let i = 0; i < sl.length; i++) {
      if (sl[i] === ol[i]) continue;
      const pats = lit.patterns.filter((p) => !p.multiline && timed(p.re, () => p.re.test(sl[i]!) && !p.re.test(ol[i]!)) && (opening || p.words.some((w) => sl[i]!.includes(w))));
      if (pats.length) {
        const fixed = restoreLine(sl[i]!, ol[i]!, pats, opening);
        if (fixed != null) { ol[i] = fixed; restored++; }
      }
      // A marker named mid-sentence ("start each line with 【Bella】 or 【Luna】") the anchored pattern
      // cannot see: put the bracket heads back when that brings every such marker back.
      const want = markerTokens(sl[i]!, lit.patterns);
      if (want.length && want.some((m) => !ol[i]!.includes(m))) {
        const fixed = bracketRestore(sl[i]!, ol[i]!, new Set(lit.patterns.flatMap((p) => p.words)));
        if (fixed != null && want.every((m) => fixed.includes(m))) { ol[i] = fixed; restored++; }
      }
    }
    text = ol.join("\n");
  }
  return { text, restored };
}

const VALUE_NOTE: Record<string, (v: string) => string> = {
  ko: (v) => ` 이 값들은 카드 코드가 글자 그대로 비교하므로, 쓸 때는 번역하지 말고 원문 표기 그대로 쓴다: ${v}.`,
  ru: (v) => ` Код карточки сравнивает эти значения буквально, поэтому не переводи их и пиши точно как в оригинале: ${v}.`,
  id: (v) => ` Nilai-nilai ini dicocokkan kata per kata oleh kode kartu, jadi saat menulisnya jangan diterjemahkan, tulis persis seperti aslinya: ${v}.`,
  zh: (v) => ` 这些值由卡片代码逐字比对，书写时不要翻译，保持原文写法：${v}。`,
  es: (v) => ` El código de la tarjeta compara estos valores literalmente: al escribirlos, no los traduzcas, déjalos tal cual: ${v}.`,
  en: (v) => ` The card's code matches these values literally: write them exactly as given, untranslated: ${v}.`,
};
/** One sentence in the target language telling the narrator to write these values as they are. */
export function valueNote(lang: string, values: string[]): string {
  return (VALUE_NOTE[lang] ?? VALUE_NOTE.en!)(values.join(", "));
}
