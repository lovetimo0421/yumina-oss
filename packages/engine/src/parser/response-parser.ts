import type { Effect, AudioEffect } from "../types/index.js";
import { ThinkingTagFilter } from "./thinking-tag-filter.js";
import { parseLeadingSpeakerTag } from "../prompts/speaker-tag.js";

export interface ParseResult {
  cleanText: string;
  effects: Effect[];
  audioEffects: AudioEffect[];
  /** `[speaker: Name]` the reply opened with (see prompts/speaker-tag.ts),
   *  lower-cased "narrator" for narration, undefined when there was no tag.
   *  Never a state effect — it names who is talking, not a variable. */
  speaker?: string;
}

/**
 * Extracts state change directives from LLM output.
 * Format: [variableId: operation value]
 * Examples: [health: -10], [gold: +50], [location: set "forest"], [hasKey: toggle]
 * Audio: [audio: trackId play], [audio: trackId stop]
 */
export class ResponseParser {
  private pattern: RegExp;
  private audioPattern: RegExp;
  // JSON directives use a bracket-balancing scanner, not a regex — non-greedy
  // regexes mis-terminate on nested `[]`/`{}` inside the value (e.g. `"comments":[]`).
  private jsonVarIdPattern = /[\w\p{L}\p{N}.$-]+/u;
  private jsonOps = ["set", "merge", "push", "delete"] as const;

  constructor(pattern?: RegExp) {
    // Both patterns tolerate optional whitespace immediately after `[` and
    // before `]` — LLMs sometimes emit `[ varId: set "x" ]` with padding.
    // Match [variableId: operation] patterns
    this.pattern =
      pattern ?? /\[\s*([\w\p{L}\p{N}.$-]+):\s*(set|add|subtract|multiply|toggle|append|\+|-|\*)?\s*("(?:[^"\\]|\\.)*"|[^\]"]+)?\s*\]/gu;
    // Match [audio: trackId action] patterns — optional chain:targetId suffix
    this.audioPattern = /\[\s*audio:\s*([\w\p{L}\p{N}-]+)\s+(play|stop|crossfade|volume)(?:\s+([\d.]+))?(?:\s+chain:([\w\p{L}\p{N}-]+))?\s*\]/gu;
  }

  parse(responseText: string, jsonVarId?: string): ParseResult {
    const effects: Effect[] = [];
    const audioEffects: AudioEffect[] = [];
    this.pattern.lastIndex = 0;
    this.audioPattern.lastIndex = 0;

    // Strip leaked thinking/reasoning blocks (e.g. Gemini Flash Lite outputs <fiction-mode>...</fiction-mode>)
    const stripped = ThinkingTagFilter.strip(responseText);

    // The speaker tag sits at the very start and must never reach the
    // standard directive pattern below, which would read it as `[speaker: set …]`.
    const speakerTag = parseLeadingSpeakerTag(stripped);

    // Extract <UpdateVariable> JSON Patch blocks (SillyTavern compatibility)
    let text = this.extractJsonPatch(speakerTag.text, effects, jsonVarId ?? "game_state");

    // Extract fenced ```json directive blocks (Gemini 3.1 Pro drift format)
    text = this.extractFencedDirectives(text, effects);

    // Extract audio directives
    text = text.replace(this.audioPattern, (_match, trackId: string, action: string, value?: string, chainTo?: string) => {
      const effect: AudioEffect = { trackId, action: action as AudioEffect["action"] };
      if (value !== undefined) {
        const num = parseFloat(value);
        if (!isNaN(num)) {
          if (action === "volume") effect.volume = num;
          else if (action === "crossfade") effect.fadeDuration = num;
        }
      }
      if (chainTo) effect.chainTo = chainTo;
      audioEffects.push(effect);
      return "";
    });

    // Extract JSON directives with bracket balancing (must come before standard
    // pattern so the bare-word pattern never catches fragments of a JSON value).
    text = this.extractJsonDirectives(text, effects);

    // Then extract standard state change directives
    const cleanText = text.replace(this.pattern, (_match, variableId: string, op?: string, rawValue?: string) => {
      const effect = this.parseDirective(variableId, op, rawValue);
      if (effect) effects.push(effect);
      return "";
    })
      // Strip structural XML tags only when they appear as standalone block-level tags on their own line
      // (safe: won't match words like "summarize" or "optional" in prose)
      .replace(/^\s*<\/?(maintext|option|sum|Analysis|UpdateVariable|JSONPatch|status_current_variable)\s*>\s*$/gim, "")
      .replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

    return speakerTag.speaker
      ? { cleanText, effects, audioEffects, speaker: speakerTag.speaker }
      : { cleanText, effects, audioEffects };
  }

  private parseDirective(
    variableId: string,
    op?: string,
    rawValue?: string
  ): Effect | null {
    // Trim whitespace that the broad unquoted-value pattern may capture
    if (rawValue) rawValue = rawValue.trim();

    // [hasKey: toggle] — no value needed
    if (op === "toggle") {
      return { variableId, operation: "toggle", value: true };
    }

    // [health: +10] shorthand
    if (op === "+" && rawValue) {
      const num = Number(rawValue);
      if (!isNaN(num)) {
        return { variableId, operation: "add", value: num };
      }
    }

    // [health: -10] shorthand
    if (op === "-" && rawValue) {
      const num = Number(rawValue);
      if (!isNaN(num)) {
        return { variableId, operation: "subtract", value: num };
      }
    }

    // [damage: *2] shorthand
    if (op === "*" && rawValue) {
      const num = Number(rawValue);
      if (!isNaN(num)) {
        return { variableId, operation: "multiply", value: num };
      }
    }

    // Explicit operations: set, add, subtract, multiply, append
    if (op && rawValue) {
      const operation = op as Effect["operation"];
      const value = this.parseValue(rawValue);
      return { variableId, operation, value };
    }

    // [health: 50] — implicit set with a number
    if (!op && rawValue) {
      const value = this.parseValue(rawValue);
      return { variableId, operation: "set", value };
    }

    // Shorthand: [health: +10] where op is the rawValue (no explicit operation word)
    if (op && !rawValue) {
      const num = Number(op);
      if (!isNaN(num)) {
        return { variableId, operation: "set", value: num };
      }
    }

    return null;
  }

  /**
   * Extract `[varId: set|merge|push|delete <json>]` directives. The value is
   * any JSON value — object/array (requires brace-balancing because regex
   * mis-terminates on nested `[]`/`{}`, e.g. `"comments":[]` inside a pushed
   * object), or a scalar (string/number/boolean/null).
   *
   * Without scalar support, `[truths: push "new truth"]` was silently
   * dropped — `push` isn't in the standard regex's op list, and the JSON
   * branch insisted on object/array openers — so well-formed AI output
   * landed in the void.
   */
  private extractJsonDirectives(text: string, effects: Effect[]): string {
    const out: string[] = [];
    const n = text.length;
    let i = 0;

    while (i < n) {
      const lb = text.indexOf("[", i);
      if (lb === -1) {
        out.push(text.slice(i));
        break;
      }
      out.push(text.slice(i, lb));

      let p = lb + 1;
      while (p < n && /\s/.test(text[p]!)) p++;

      const varMatch = this.jsonVarIdPattern.exec(text.slice(p));
      if (!varMatch || varMatch.index !== 0) {
        out.push("[");
        i = lb + 1;
        continue;
      }
      const variableId = varMatch[0];
      p += variableId.length;

      if (text[p] !== ":") {
        out.push("[");
        i = lb + 1;
        continue;
      }
      p++;
      while (p < n && /\s/.test(text[p]!)) p++;

      let op: typeof this.jsonOps[number] | null = null;
      for (const candidate of this.jsonOps) {
        if (text.slice(p, p + candidate.length) === candidate) {
          const after = text[p + candidate.length];
          if (after && /\s/.test(after)) {
            op = candidate;
            p += candidate.length;
            break;
          }
        }
      }
      if (!op) {
        out.push("[");
        i = lb + 1;
        continue;
      }
      while (p < n && /\s/.test(text[p]!)) p++;

      // Locate the end of the JSON value. q ends one past the last value char
      // on success, or -1 if no recognizable JSON value begins at p.
      const q = this.scanJsonValue(text, p, n);
      if (q === -1) {
        // Unrecognized value shape — fall through to standard-pattern path.
        out.push("[");
        i = lb + 1;
        continue;
      }

      const jsonStr = text.slice(p, q);
      let r = q;
      while (r < n && /\s/.test(text[r]!)) r++;
      if (text[r] !== "]") {
        out.push("[");
        i = lb + 1;
        continue;
      }
      r++;

      try {
        const parsed = JSON.parse(jsonStr);
        effects.push({
          variableId,
          operation: op as Effect["operation"],
          value: parsed,
        });
      } catch {
        // Malformed JSON — swallow the whole directive so a broken value
        // doesn't leak as visible text.
      }
      i = r;
    }

    return out.join("");
  }

  /**
   * Find the end of a JSON value starting at `p` in `text`. Returns the
   * index one past the last character of the value, or -1 if no recognizable
   * JSON value begins at `p`.
   *
   * Supports objects, arrays, strings, numbers, booleans, and null. Bare
   * identifiers (e.g. `forest` in `[location: set forest]`) return -1 so
   * the caller can fall through to the standard non-JSON directive path.
   */
  private scanJsonValue(text: string, p: number, n: number): number {
    if (p >= n) return -1;
    const ch = text[p]!;

    // Object / array — brace-balanced scan
    if (ch === "{" || ch === "[") {
      let brace = 0;
      let bracket = 0;
      let inString = false;
      let escape = false;
      let q = p;
      for (; q < n; q++) {
        const c = text[q]!;
        if (escape) { escape = false; continue; }
        if (c === "\\") { escape = true; continue; }
        if (inString) {
          if (c === '"') inString = false;
          continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === "{") brace++;
        else if (c === "}") brace--;
        else if (c === "[") bracket++;
        else if (c === "]") bracket--;
        if (brace === 0 && bracket === 0) { q++; break; }
      }
      if (brace !== 0 || bracket !== 0) return -1;
      return q;
    }

    // Quoted string — scan to unescaped closing quote
    if (ch === '"') {
      let q = p + 1;
      let escape = false;
      for (; q < n; q++) {
        const c = text[q]!;
        if (escape) { escape = false; continue; }
        if (c === "\\") { escape = true; continue; }
        if (c === '"') return q + 1;
      }
      return -1; // unterminated
    }

    // Number — strict JSON grammar: -? (0 | [1-9]\d*) (\.\d+)? ([eE][+-]?\d+)?
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let q = p;
      if (text[q] === "-") q++;
      if (q >= n) return -1;
      const first = text[q]!;
      if (first === "0") {
        q++;
      } else if (first >= "1" && first <= "9") {
        while (q < n && text[q]! >= "0" && text[q]! <= "9") q++;
      } else {
        return -1;
      }
      if (text[q] === ".") {
        q++;
        if (q >= n || text[q]! < "0" || text[q]! > "9") return -1;
        while (q < n && text[q]! >= "0" && text[q]! <= "9") q++;
      }
      if (text[q] === "e" || text[q] === "E") {
        q++;
        if (text[q] === "+" || text[q] === "-") q++;
        if (q >= n || text[q]! < "0" || text[q]! > "9") return -1;
        while (q < n && text[q]! >= "0" && text[q]! <= "9") q++;
      }
      return q;
    }

    // Literals
    if (text.slice(p, p + 4) === "true" || text.slice(p, p + 4) === "null") return p + 4;
    if (text.slice(p, p + 5) === "false") return p + 5;

    return -1;
  }

  /**
   * Extract fenced code blocks whose entire content is a directive
   * object/array — the shape some models (observed: Gemini 3.1 Pro) drift
   * into when they rewrite inline directives as JSON:
   *
   *   ```json
   *   [
   *    {"place": "set 第一层-福利中心"},
   *    {"mission": "set 休假体验福利中心"}
   *   ]
   *   ```
   *
   * Without this, the block leaks into the visible narrative AND the
   * variable changes are silently lost.
   *
   * All-or-nothing gate: the block is consumed only if every key is
   * variable-id-shaped and every value is a string that parses as a known
   * operation ("set X", "add 5", "toggle", "+5", ...). Anything else —
   * story JSON, code samples, numeric values — leaves the fence untouched
   * so legitimate fenced JSON in narrative is never eaten. Unknown
   * variable ids in a consumed block are still no-ops downstream
   * (GameStateManager skips unresolved variables).
   */
  private extractFencedDirectives(text: string, effects: Effect[]): string {
    const fencePattern = /```[ \t]*[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)```/g;
    return text.replace(fencePattern, (match, body: string) => {
      const parsed = this.tryParseDirectiveBlock(body);
      if (!parsed) return match;
      effects.push(...parsed);
      return "";
    });
  }

  /** Parse a fence body as a directive object/array, or null if it isn't one. */
  private tryParseDirectiveBlock(body: string): Effect[] | null {
    const trimmed = body.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const objs = Array.isArray(parsed) ? parsed : [parsed];
    if (objs.length === 0) return null;

    const collected: Effect[] = [];
    for (const obj of objs) {
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
      const entries = Object.entries(obj as Record<string, unknown>);
      if (entries.length === 0) return null;
      for (const [key, value] of entries) {
        if (!this.isVarIdShaped(key)) return null;
        if (typeof value !== "string") return null;
        const effect = this.parseOpString(key, value.trim());
        if (!effect) return null;
        collected.push(effect);
      }
    }
    return collected;
  }

  /** True when the whole key matches the variable-id character set. */
  private isVarIdShaped(key: string): boolean {
    const m = this.jsonVarIdPattern.exec(key);
    return m !== null && m.index === 0 && m[0].length === key.length;
  }

  /**
   * Parse an "operation value" string ("set 第一层", "add 5", "toggle",
   * "+5") into an Effect. Returns null when the string doesn't start with
   * a recognized operation — the caller treats that as "not a directive".
   */
  private parseOpString(variableId: string, raw: string): Effect | null {
    if (raw === "toggle") {
      return { variableId, operation: "toggle", value: true };
    }

    // Shorthand: "+5" / "-3" / "*2"
    const short = /^([+\-*])\s*(\d+(?:\.\d+)?)$/.exec(raw);
    if (short) {
      return this.parseDirective(variableId, short[1]!, short[2]!);
    }

    const m = /^(set|add|subtract|multiply|append|merge|push|delete)\s+([\s\S]+)$/.exec(raw);
    if (!m) return null;
    const op = m[1]!;
    const rest = m[2]!.trim();

    // merge/push/delete carry JSON payloads in the inline syntax; accept
    // both a JSON value and a bare scalar here.
    if (op === "merge" || op === "push" || op === "delete") {
      try {
        return {
          variableId,
          operation: op as Effect["operation"],
          value: JSON.parse(rest) as Effect["value"],
        };
      } catch {
        return { variableId, operation: op as Effect["operation"], value: this.parseValue(rest) };
      }
    }

    return this.parseDirective(variableId, op, rest);
  }

  /**
   * Extract <UpdateVariable> blocks containing JSON Patch operations.
   * Converts each patch op into a Yumina Effect targeting a JSON variable.
   *
   * Supported ops:
   *   replace → set at dot-path
   *   delta   → add (positive) or subtract (negative) at dot-path
   *   insert  → set at dot-path (creates new key)
   *   remove  → delete at dot-path
   */
  private extractJsonPatch(text: string, effects: Effect[], rootVarId: string): string {
    const updateVarPattern = /<UpdateVariable>[\s\S]*?<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>[\s\S]*?<\/UpdateVariable>/gi;

    return text.replace(updateVarPattern, (_match, patchJson: string) => {
      try {
        const patches = JSON.parse(patchJson) as Array<{
          op: string;
          path: string;
          value?: unknown;
        }>;

        for (const patch of patches) {
          // Convert JSON Patch path "/避难所/电力/当前负载值" to dot-path "game_state.避难所.电力.当前负载值"
          const dotPath = patch.path
            .replace(/^\//, "")           // remove leading slash
            .replace(/\//g, ".");         // slashes → dots
          const fullPath = `${rootVarId}.${dotPath}`;

          switch (patch.op) {
            case "replace":
            case "insert":
              effects.push({
                variableId: fullPath,
                operation: "set",
                value: patch.value as Effect["value"],
              });
              break;
            case "delta": {
              const num = Number(patch.value);
              if (!isNaN(num)) {
                effects.push({
                  variableId: fullPath,
                  operation: num >= 0 ? "add" : "subtract",
                  value: Math.abs(num),
                });
              }
              break;
            }
            case "remove":
              effects.push({
                variableId: fullPath,
                operation: "delete",
                value: true,
              });
              break;
          }
        }
      } catch {
        // Invalid JSON Patch — skip block
      }

      // Remove the entire <UpdateVariable> block from display text
      return "";
    });
  }

  private parseValue(raw: string): number | string | boolean | Record<string, unknown> | unknown[] {
    // Quoted string
    if (raw.startsWith('"') && raw.endsWith('"')) {
      return raw.slice(1, -1).replace(/\\"/g, '"');
    }

    // Boolean
    if (raw === "true") return true;
    if (raw === "false") return false;

    // Number
    const num = Number(raw);
    if (!isNaN(num)) return num;

    // Fall back to string
    return raw;
  }
}
