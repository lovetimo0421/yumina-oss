/**
 * Which AI calls does a card's frontend make on its own?
 *
 * A card can ask the model directly from its TSX — `api.ai.complete(...)` for
 * a side actor, `api.ai.decide(...)` for a bounded choice, `api.ai.context(...)`
 * to assemble world direction. 85 of the published cards do, and until now the
 * canvas had no idea: the AI block listed the narrator and the declared
 * stations, and the frontend block showed a phone. The call that drives the
 * whole card (Godot's two companions, 1984's room director) was invisible.
 *
 * Same approach as `variable-read-scan.ts`: a regex over the source, because
 * the engine has no parser and the pattern the docs teach is shallow and
 * stable. We read the FIRST argument object for the handful of literal keys
 * that say what the call touches — which worldbooks, how much lore, whether
 * it rides the session context — and report the rest as unknown rather than
 * guess.
 */

export type FrontendAiCallKind = "complete" | "decide" | "context";

export interface FrontendAiCall {
  /** File the call is written in. */
  file: string;
  /** 1-based line of the call. */
  line: number;
  /** 1-based column of the call on its line. A compiled bundle is one line,
   *  so the line alone does not tell two of its calls apart. */
  column: number;
  kind: FrontendAiCallKind;
  /** Worldbook ids named literally in `worldbookIds: [...]`. */
  worldbookIds: string[];
  /** `worldbookIds` was present but built at runtime (a template literal, a
   *  variable, the shorthand `{ worldbookIds }`) — the call picks its module
   *  per call. */
  dynamicWorldbookIds: boolean;
  /** For a dynamic id written as a template (\`still-${who}\`): the fixed
   *  part before the first hole. A reader can match it against the card's
   *  worldbook ids to say which modules the call CAN pick. */
  worldbookIdPrefixes: string[];
  /** `includeLorebook` as written; undefined when absent. */
  includeLorebook?: boolean | "all" | "matched";
  /** `context: "session"` — the call rides the player's session (persona,
   *  presets, saved-state lore activation). */
  sessionContext: boolean;
  /** The caller asked for a JSON object / schema answer. */
  json: boolean;
  /** A literal `model:` override, when written as a string. */
  model?: string;
  /** A literal `temperature:` number, when written as one. */
  temperature?: number;
  /** A literal `maxTokens:` number, when written as one. */
  maxTokens?: number;
  /** `temperature` or `maxTokens` is present but computed at runtime. */
  dynamicSampling?: boolean;
  /** `model:` is written but computed at runtime. */
  dynamicModel?: boolean;
  /** With a computed model: the card variable it is read out of just before
   *  the call (`api.variables["unperson-referee-model"]`), so the creator can
   *  change it there. */
  modelVariable?: string;
  /** The code reads the card's entries itself (`api.entries`) just before
   *  the call: it hands the AI lore it picked, not the engine's. */
  picksEntries?: boolean;
  /** A `callAi(` comes just before it: this call is the fallback for when
   *  calling one of the card's AIs did not answer (1984's referee), not an
   *  AI of its own. */
  fallbackOfCallAi?: boolean;
}

/** How far before a call its arguments are looked for when they are built
 *  in variables first (1984's referee builds them a few hundred characters
 *  up). Short enough that an unrelated read further up the file is not it. */
const LEAD = 1500;
const MODEL_VARIABLE = /\bvariables\s*(?:\?\.\s*)?(?:\[\s*["']([^"']*model[^"']*)["']\s*\]|\.\s*([A-Za-z_$][\w$]*model[\w$]*))/gi;
const READS_ENTRIES = /\bapi\s*\??\.\s*entries\b/;
const CALLS_AI = /\bcallAi\s*\(/;

// A member access, optional or not: `.`, `?.`, with any spacing.
const DOT = String.raw`\s*\??\.\s*`;
// `api.ai.complete(`, `api?.ai?.complete(`, `api.ai.complete?.(`.
const CALL = new RegExp(String.raw`\b([A-Za-z_$][\w$]*)${DOT}ai${DOT}(complete|decide|context)\s*(?:\?\.\s*)?\(`, "g");
/** Cheap gate before a file is lexed at all: an `ai` somewhere, and a call
 *  to one of the three methods under any name (`model.decide(` once `ai` has
 *  been pulled out as `model`). */
const MAYBE_AI = /\bai\b/;
const MAYBE_CALL = /\b(?:complete|decide|context)\s*(?:\?\.\s*)?\(/;

type Range = [start: number, end: number];

const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%~^".split(""));
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "instanceof", "new", "throw",
]);
const isIdent = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch);

/**
 * The comment and literal spans of a source file, found in one pass. Not a
 * parser — enough of a lexer that a call written in a comment or a string is
 * not taken for a real one, and that the apostrophe in a `// don't` does not
 * open a "string" that runs on into the next call.
 *
 * Hand-written TSX has text a JS lexer does not expect (JSX's `Don't`,
 * `</div>`), so a quote or a regex that does not close on its own line is
 * taken for plain text rather than a literal: a JS string or regex cannot
 * span lines, and guessing wrong then costs one line instead of the file.
 */
function lexSpans(src: string): { comments: Range[]; literals: Range[] } {
  const comments: Range[] = [];
  const literals: Range[] = [];
  const holes: number[] = []; // brace depth each open `${` hole returns to
  const n = src.length;
  let depth = 0;
  let last = ""; // last significant code character
  let i = 0;

  // Template text from `from` (just past a backtick or a hole's `}`) to the
  // closing backtick or the next `${`. Returns where code resumes.
  const template = (from: number): number => {
    let j = from;
    while (j < n) {
      const ch = src[j]!;
      if (ch === "\\") { j += 2; continue; }
      if (ch === "`") { literals.push([from, j]); last = "`"; return j + 1; }
      if (ch === "$" && src[j + 1] === "{") {
        literals.push([from, j]);
        holes.push(depth);
        depth++;
        last = "{";
        return j + 2;
      }
      j++;
    }
    literals.push([from, n]);
    return n;
  };

  const wordBefore = (at: number): string => {
    let e = at;
    while (e > 0 && /\s/.test(src[e - 1]!)) e--;
    let s = e;
    while (s > 0 && isIdent(src[s - 1])) s--;
    return src.slice(s, e);
  };

  while (i < n) {
    const ch = src[i]!;
    if (ch === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      if (j < n && src[j] === ch) {
        literals.push([i + 1, j]);
        last = ch;
        i = j + 1;
        continue;
      }
      // Unclosed on its line: JSX text, not a string.
      i++;
      continue;
    }
    if (ch === "`") { i = template(i + 1); continue; }
    if (ch === "/" && (last === "" || REGEX_AFTER.has(last) || (isIdent(last) && REGEX_AFTER_WORD.has(wordBefore(i))))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const c = src[j]!;
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j++;
      }
      if (j < n && src[j] === "/") {
        literals.push([i + 1, j]);
        last = "/";
        i = j + 1;
        while (i < n && isIdent(src[i])) i++;
        continue;
      }
      // No closing slash on the line: a division, or a JSX `</`.
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (holes.length > 0 && holes[holes.length - 1] === depth) {
        holes.pop();
        i = template(i + 1);
        continue;
      }
    }
    if (!/\s/.test(ch)) last = ch;
    i++;
  }
  return { comments, literals };
}

/** `src` with the given spans blanked to spaces — same length, newlines kept,
 *  so every index and line number still points at the original. */
function blank(src: string, spans: Range[]): string {
  if (spans.length === 0) return src;
  const parts: string[] = [];
  let at = 0;
  for (const [s, e] of spans) {
    if (e <= s) continue;
    parts.push(src.slice(at, s), src.slice(s, e).replace(/[^\n]/g, " "));
    at = e;
  }
  parts.push(src.slice(at));
  return parts.join("");
}

/** The span of a call's first argument, matched on the literal-free code so
 *  no bracket inside a string or a comment counts. Bounded so a pathological
 *  file cannot stall the scan. */
function firstArgumentSpan(code: string, openParen: number, limit = 4000): Range {
  let depth = 0;
  const end = Math.min(code.length, openParen + limit);
  for (let i = openParen; i < end; i++) {
    const ch = code[i]!;
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return [openParen + 1, i];
    }
  }
  return [openParen + 1, end];
}

/** Line and column of each index, handed in ascending order: one walk over
 *  the file however many calls it holds (it used to recount from the top for
 *  every call). */
function positions(source: string, indices: number[]): Array<{ line: number; column: number }> {
  const out: Array<{ line: number; column: number }> = [];
  let line = 1;
  let lineStart = 0;
  let at = 0;
  for (const index of indices) {
    for (; at < index; at++) {
      if (source.charCodeAt(at) === 10) { line++; lineStart = at + 1; }
    }
    out.push({ line, column: index - lineStart + 1 });
  }
  return out;
}

/** Names the sandbox's `ai` namespace was pulled out under:
 *  `const { ai } = api`, `const { ai: model } = useYumina()`, `const ai = api.ai`. */
function aiAliases(code: string): string[] {
  const names = new Set<string>();
  const destructure = /\{([^{}]*\bai\b[^{}]*)\}\s*=(?![=>])\s*(this\b)?/g;
  let m: RegExpExecArray | null;
  while ((m = destructure.exec(code)) !== null) {
    if (m[2]) continue;
    for (const part of m[1]!.split(",")) {
      const p = /^\s*ai\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=[^,]*)?$/.exec(part);
      if (p) names.add(p[1] ?? "ai");
    }
  }
  const assign = new RegExp(
    String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:(this)|[A-Za-z_$][\w$]*)(?:${DOT}[A-Za-z_$][\w$]*)*?${DOT}ai(?![\w$]|\s*\??\.|\s*\()`,
    "g",
  );
  while ((m = assign.exec(code)) !== null) if (!m[2]) names.add(m[1]!);
  return [...names];
}

const STRING_LITERAL = /["']([^"']+)["']/g;

/** What follows `key:` in the argument, as written. The key is looked for in
 *  the literal-free code, so a `worldbookIds:` inside a string is not it. */
function afterKey(argCode: string, argText: string, key: string): string | null {
  const k = new RegExp(String.raw`\b${key}\s*:`).exec(argCode);
  return k ? argText.slice(k.index + k[0].length).replace(/^\s+/, "") : null;
}

/** Results per files object. The editor keeps the same object until the
 *  interface code itself changes, and the canvas asks about it from every
 *  situation's AI block, the Context form and the custom panels on each
 *  edit anywhere in the card: a 2MB bundle was scanned dozens of times a
 *  keystroke. The result is shared, so callers must not mutate it. */
const scanned = new WeakMap<Record<string, string>, readonly FrontendAiCall[]>();

export function extractAiCallsFromFiles(files: Record<string, string>): FrontendAiCall[] {
  const hit = scanned.get(files);
  if (hit) return hit as FrontendAiCall[];
  const calls = scanFiles(files);
  scanned.set(files, calls);
  return calls;
}

function scanFiles(files: Record<string, string>): FrontendAiCall[] {
  const calls: FrontendAiCall[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (typeof source !== "string" || !MAYBE_AI.test(source) || !MAYBE_CALL.test(source)) continue;
    // A compiled bundle keeps the shape (`X.ai.complete(`), so this works on
    // a 2MB single-file card as well as on hand-written modules.
    const { comments, literals } = lexSpans(source);
    // `text` keeps the strings (the ids are read out of it); `code` blanks
    // them too, and is where calls, brackets and keys are looked for.
    const text = blank(source, comments);
    const code = blank(source, [...comments, ...literals].sort((a, b) => a[0] - b[0]));

    const found: Array<{ index: number; open: number; kind: FrontendAiCallKind }> = [];
    let m: RegExpExecArray | null;
    CALL.lastIndex = 0;
    while ((m = CALL.exec(code)) !== null) {
      const root = m[1]!;
      // `this.ai.complete` inside a class, or a type annotation `ai: {...}`,
      // are not calls on the sandbox API. Everything else is accepted: cards
      // alias the api under any name (`requestAPI`, `y`, `yumina`).
      if (root === "this" || root === "type") continue;
      found.push({ index: m.index, open: m.index + m[0].length - 1, kind: m[2] as FrontendAiCallKind });
    }
    const aliases = aiAliases(code);
    if (aliases.length > 0) {
      // A bare `ai.complete(` counts only under a name the file pulled `ai`
      // out as, and never as the tail of `x.ai.complete(` (counted above).
      const names = aliases.map((a) => a.replace(/\$/g, "\\$")).join("|");
      const viaAlias = new RegExp(String.raw`(?<![\w$])(?<!\.\s*)(?:${names})(?![\w$])${DOT}(complete|decide|context)\s*(?:\?\.\s*)?\(`, "g");
      while ((m = viaAlias.exec(code)) !== null) {
        found.push({ index: m.index, open: m.index + m[0].length - 1, kind: m[1] as FrontendAiCallKind });
      }
      found.sort((a, b) => a.index - b.index);
    }
    const at = positions(source, found.map((f) => f.index));

    found.forEach(({ open, kind }, n) => {
      const [a, b] = firstArgumentSpan(code, open);
      const arg = text.slice(a, b);
      const argCode = code.slice(a, b);
      const call: FrontendAiCall = {
        file, line: at[n]!.line, column: at[n]!.column, kind,
        worldbookIds: [], dynamicWorldbookIds: false, worldbookIdPrefixes: [],
        sessionContext: /^["']session["']/.test(afterKey(argCode, arg, "context") ?? ""),
        json: /\bresponseFormat\s*:/.test(argCode),
      };
      const books = afterKey(argCode, arg, "worldbookIds");
      if (books !== null) {
        const body = /^(\[[^\]]*\]|[^,}\n]+)/.exec(books)?.[1] ?? "";
        if (body.startsWith("[")) {
          const ids: string[] = [];
          let s: RegExpExecArray | null;
          STRING_LITERAL.lastIndex = 0;
          while ((s = STRING_LITERAL.exec(body)) !== null) ids.push(s[1]!);
          // A template literal or an identifier inside the array means at
          // least one id is computed.
          call.dynamicWorldbookIds = /`|[A-Za-z_$][\w$]*\s*(?:,|\])/.test(body.replace(/["'][^"']*["']/g, ""));
          call.worldbookIds = ids;
          const prefixes: string[] = [];
          const tpl = /`([^`$]*)\$\{/g;
          let p: RegExpExecArray | null;
          while ((p = tpl.exec(body)) !== null) if (p[1]) prefixes.push(p[1]);
          call.worldbookIdPrefixes = prefixes;
        } else {
          call.dynamicWorldbookIds = true;
        }
      } else if (/[{,]\s*worldbookIds\s*(?=[,}])/.test(argCode)) {
        // `{ messages, worldbookIds }` — the shorthand names a variable, so
        // the ids are whatever it holds when the call runs. It used to read
        // as "no worldbooks named, not dynamic": a call that picks its module
        // drawn as one that picks none.
        call.dynamicWorldbookIds = true;
      }
      const lore = /^(true|false|["'](?:all|matched)["'])/.exec(afterKey(argCode, arg, "includeLorebook") ?? "");
      if (lore) {
        const v = lore[1]!;
        call.includeLorebook = v === "true" ? true : v === "false" ? false : (v.slice(1, -1) as "all" | "matched");
      }
      const modelRaw = afterKey(argCode, arg, "model");
      const model = /^["']([^"']+)["']/.exec(modelRaw ?? "");
      const lead = Math.max(0, found[n]!.index - LEAD);
      if (model) call.model = model[1]!;
      else if (modelRaw !== null || /[{,]\s*model\s*(?=[,}])/.test(argCode)) {
        call.dynamicModel = true;
        let v: RegExpExecArray | null, last: string | undefined;
        MODEL_VARIABLE.lastIndex = 0;
        const window = text.slice(lead, b);
        while ((v = MODEL_VARIABLE.exec(window)) !== null) last = v[1] ?? v[2];
        if (last) call.modelVariable = last;
      }
      if (READS_ENTRIES.test(code.slice(lead, b))) call.picksEntries = true;
      if (CALLS_AI.test(code.slice(lead, found[n]!.index))) call.fallbackOfCallAi = true;
      for (const key of ["temperature", "maxTokens"] as const) {
        const raw = afterKey(argCode, arg, key);
        if (raw === null) {
          if (new RegExp(String.raw`[{,]\s*${key}\s*(?=[,}])`).test(argCode)) call.dynamicSampling = true;
          continue;
        }
        const num = /^(-?\d+(?:\.\d+)?)(?=\s*[,}\n])/.exec(raw);
        if (num) call[key] = Number(num[1]);
        else call.dynamicSampling = true;
      }
      calls.push(call);
    });
  }
  return calls;
}
