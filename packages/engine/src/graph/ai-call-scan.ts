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
  kind: FrontendAiCallKind;
  /** Worldbook ids named literally in `worldbookIds: [...]`. */
  worldbookIds: string[];
  /** `worldbookIds` was present but built at runtime (a template literal, a
   *  variable) — the call picks its module per call. */
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
}

const CALL = /\b([A-Za-z_$][\w$]*)\s*\.\s*ai\s*\.\s*(complete|decide|context)\s*\(/g;

/** The text of a call's first argument: from the opening paren to its match,
 *  bounded so a pathological file cannot stall the scan. */
function firstArgument(source: string, openParen: number, limit = 4000): string {
  let depth = 0;
  let inString: string | null = null;
  const end = Math.min(source.length, openParen + limit);
  for (let i = openParen; i < end; i++) {
    const ch = source[i]!;
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1, end);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

const STRING_LITERAL = /["']([^"']+)["']/g;

export function extractAiCallsFromFiles(files: Record<string, string>): FrontendAiCall[] {
  const calls: FrontendAiCall[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (typeof source !== "string" || !source.includes(".ai.")) continue;
    // A compiled bundle keeps the shape (`X.ai.complete(`), so this works on
    // a 2MB single-file card as well as on hand-written modules.
    CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL.exec(source)) !== null) {
      const root = m[1]!;
      // `this.ai.complete` inside a class, or a type annotation `ai: {...}`,
      // are not calls on the sandbox API. Everything else is accepted: cards
      // alias the api under any name (`requestAPI`, `y`, `yumina`).
      if (root === "this" || root === "type") continue;
      const open = m.index + m[0].length - 1;
      const arg = firstArgument(source, open);
      const kind = m[2] as FrontendAiCallKind;
      const call: FrontendAiCall = {
        file, line: lineOf(source, m.index), kind,
        worldbookIds: [], dynamicWorldbookIds: false, worldbookIdPrefixes: [],
        sessionContext: /\bcontext\s*:\s*["']session["']/.test(arg),
        json: /\bresponseFormat\s*:/.test(arg),
      };
      const books = /\bworldbookIds\s*:\s*(\[[^\]]*\]|[^,}\n]+)/.exec(arg);
      if (books) {
        const body = books[1]!;
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
      }
      const lore = /\bincludeLorebook\s*:\s*(true|false|["'](?:all|matched)["'])/.exec(arg);
      if (lore) {
        const v = lore[1]!;
        call.includeLorebook = v === "true" ? true : v === "false" ? false : (v.slice(1, -1) as "all" | "matched");
      }
      const model = /\bmodel\s*:\s*["']([^"']+)["']/.exec(arg);
      if (model) call.model = model[1]!;
      calls.push(call);
    }
  }
  return calls;
}
