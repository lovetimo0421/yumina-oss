import type { Effect, AudioEffect, Variable, WorldDefinition } from "../types/index.js";
import { ThinkingTagFilter } from "./thinking-tag-filter.js";
import { parseLeadingSpeakerTag } from "../prompts/speaker-tag.js";
import { stripStateReceipts } from "./state-receipt.js";
import { unwrapBookkeepingBlocks, dropMarkedBookkeeping } from "./bookkeeping-blocks.js";
import {
  DIRECTIVE_OP_WORDS,
  isEmptyBookkeepingSpan,
  jsonPatchSpan,
  type JsonPatchOp,
  isPlaceholderKey,
  keyRoot,
  spanKey,
  stripBookkeepingLines,
  stripPlaceholderRoots,
  type BracketLineContext,
} from "./directive-lines.js";
import { replyRuleMatcher, type ReplyRule } from "./reply-rules.js";
import { resolveEffectVariable } from "../state/variable-activation.js";

/** `[image:…]` / `[video:…]` bodies the directive scanners must leave intact:
 *  the render form (URL / asset ref / cdn path, optional `|key=value` options)
 *  and the bare scene handle the AI writes. Anything else (e.g.
 *  `[image: set x]`) is still a plain variable directive. */
const IMAGE_EMBED_RE =
  /\[\s*(?:image:\s*(?:https?:\/\/[^\]\n]+|@asset:[^\]\n]+|\/cdn\/[^\]\n]+|[\p{L}\p{N}_-]+)|video:\s*(?:https?:\/\/[^\]\n]+|@asset:[^\]\n]+|\/cdn\/[^\]\n]+))\s*\]/giu;

/** `[bg: handle]`, read by the background resolver after parsing (see
 *  background-directives.ts). Until now the standard pattern ate it first as
 *  a write to a variable `bg`, so the resolver never saw it. Shielded when
 *  the world has backgrounds and no variable called `bg`; otherwise it stays
 *  a plain directive, as before. */
const BG_TAG_RE = /\[\s*bg\s*:\s*[^\]\n]{1,80}\]/gi;

/** `[variable: mood: set "angry"]`, `[variableId: hp: +5]`, `[var: x: …]` —
 *  the word from the old format line (`[variableId: operation value]`) taken
 *  literally as a prefix. Dropped so the directive applies and is stripped
 *  like `[mood: set "angry"]`. Only a prefix when another `<id>:` follows, so
 *  a real variable named `var` or `variable` still writes normally
 *  (`[var: set 3]`, `[variable: +1]`). */
export const DIRECTIVE_VARIABLE_PREFIX_RE =
  /\[\s*(?:variable[_-]?id|variables?|vars?)\s*:\s*(?=[\w\p{L}\p{N}$·・-]+(?:\.[\w\p{L}\p{N}$·・-]+(?: [\w\p{L}\p{N}$·・-]+)*)*\s*:)/giu;

/** A state line the reply wrote that was taken out of the story but could
 *  not be applied (malformed, unknown target, wrong value type). */
export interface UnappliedDirective {
  /** The bracket span as written, e.g. `[events: set "X" true]`. */
  text: string;
  /** Variable ids it names (dot-path roots), for the missed-update repair. */
  targets: string[];
}

export interface ParseResult {
  cleanText: string;
  effects: Effect[];
  audioEffects: AudioEffect[];
  /** `[speaker: Name]` the reply opened with (see prompts/speaker-tag.ts),
   *  lower-cased "narrator" for narration, undefined when there was no tag.
   *  Never a state effect — it names who is talking, not a variable. */
  speaker?: string;
  /** Bookkeeping lines hidden from the story but not applied. Present only
   *  when there are some. */
  unapplied?: UnappliedDirective[];
}

export interface ParseOptions {
  /** Keep `[image:…]` embeds out of the directive scanners (default true).
   *  Pass false for a world that has its own variable called `image`: there
   *  `[image: …]` has always been a write to that variable, and a card's
   *  custom UI may depend on it. */
  shieldImages?: boolean;
  /** The reply's world. Bracket-only lines are judged against its variable
   *  ids and reply rules, and malformed state lines are recovered into
   *  writes on its real, AI-writable variables. */
  world?: Pick<WorldDefinition, "variables"> & Partial<Pick<WorldDefinition, "replyRules" | "backgrounds">>;
  /** Variable ids only, for display without the world (the chat bubble).
   *  Ignored when `world` is given. */
  variableIds?: Iterable<string>;
  /** Display callers carry the same authored protection as server parsing. */
  replyRules?: readonly ReplyRule[];
}

const OP_SEGMENT_RE = new RegExp(`^(${DIRECTIVE_OP_WORDS.join("|")})(?:\\s+([\\s\\S]*))?$`);
const SHORTHAND_SEGMENT_RE = /^([+\-*])\s*(\d+(?:\.\d+)?)$/;
const SPACED_TARGET_SEGMENT_RE = new RegExp(
  `^([\\w\\p{L}\\p{N}$·・-]+(?:\\.[\\w\\p{L}\\p{N}$·・-]+)*)\\s+((?:${DIRECTIVE_OP_WORDS.join("|")})(?:\\s[\\s\\S]*)?|[+\\-*]\\s*\\d+(?:\\.\\d+)?)$`,
  "u",
);
/** An unquoted value that is really several changes: `3, pride: -4`,
 *  `5, append "x"`, `-1, +2`. The standard pattern must not take the whole
 *  tail as one value. */
const CHAINED_TAIL_RE = new RegExp(
  `,\\s*(?:"[^"\\n]+"|[\\w\\p{L}\\p{N}$·・.-]+)\\s*[:：]|,\\s*(?:${DIRECTIVE_OP_WORDS.join("|")})\\b|,\\s*[+\\-*]\\s*\\d`,
  "u",
);
const QUOTED_KEY_SEGMENT_RE = /^"([^"\n]{1,200})"\s*[:：]\s*([\s\S]+)$/;
const BARE_KEY_SEGMENT_RE = /^([\w\p{L}\p{N}$·・-]+(?:\.[\w\p{L}\p{N}$·・-]+)*)\s*[:：]\s*([\s\S]+)$/u;
const TARGET_TOKEN_RE = /[\w\p{L}\p{N}$·・-]+(?:\.[\w\p{L}\p{N}$·・-]+)*/gu;
/** A quoted string that is a value, not a key (`"x"` not followed by `:`). */
const QUOTED_VALUE_RE = /"(?:[^"\\]|\\.)*"(?!\s*[:：])/g;

function patchTargets(patch: JsonPatchOp[], ids: ReadonlySet<string> | undefined): string[] {
  if (!ids) return [];
  return [...new Set(patch.map((p) => keyRoot(p.path.replace(/^\//, "").replace(/\//g, "."), ids)).filter((r) => ids.has(r)))];
}

/** The variable ids a span names: its key and any keys inside it, never words
 *  inside its string values. */
function spanTargets(spanText: string, ids: ReadonlySet<string> | undefined): string[] {
  if (!ids) return [];
  // After a dot-path that is no variable (`[x.npc: {"mood": …}]`) the quoted
  // keys are that object's fields, not variables.
  const parsed = spanKey(spanText, ids);
  const fieldsOnly = parsed !== null && parsed.key.includes(".") && !ids.has(keyRoot(parsed.key, ids));
  const scrubbed = fieldsOnly ? spanText.replace(/"(?:[^"\\]|\\.)*"/g, " ") : spanText.replace(QUOTED_VALUE_RE, " ");
  return [...new Set(
    (scrubbed.match(TARGET_TOKEN_RE) ?? [])
      .map((token) => keyRoot(token, ids))
      .filter((root) => ids.has(root)),
  )];
}

/** A ``` / ~~~ fence left holding only whitespace once its bookkeeping was
 *  taken out (`\`\`\`json\n[{"op":…}]\n\`\`\``) renders as an empty box: drop it.
 *  Fences are paired line by line, so two neighbouring fences are never read
 *  as one; a fence that still has content is left exactly as it was. */
function dropEmptyFences(text: string): string {
  if (!text.includes("```") && !text.includes("~~~")) return text;
  const lines = text.split("\n");
  const drop = new Set<number>();
  let open: { index: number; marker: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]*(```|~~~)/.exec(lines[i]!);
    if (!m) continue;
    if (!open) { open = { index: i, marker: m[1]! }; continue; }
    if (m[1] !== open.marker || lines[i]!.trim() !== open.marker) continue;
    const body = lines.slice(open.index + 1, i);
    if (body.every((l) => !l.trim())) for (let j = open.index; j <= i; j++) drop.add(j);
    open = null;
  }
  return drop.size ? lines.filter((_, i) => !drop.has(i)).join("\n") : text;
}

/** Split on commas that are not inside quotes, brackets or braces. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts;
}

/** One value, or undefined when it is not a single clean value: JSON
 *  (string, number, boolean, object, array) or bare text with no quotes or
 *  brackets in it. `"X" true`, `here "manor"` are not values. */
function strictValue(raw: string): Effect["value"] | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  try {
    const v = JSON.parse(t) as unknown;
    return v === null ? undefined : (v as Effect["value"]);
  } catch {
    return /["{}[\]]/.test(t) ? undefined : t;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A write to a number variable must carry a single number (`[heart: set
 *  high]` or a leftover tail is never applied as-is), and arithmetic on a
 *  text or switch variable is not a write. Other targets pass. */
function numberWriteFits(world: { variables: Variable[] }, effect: Effect): boolean {
  if (effect.variableId.includes(".") || /\[\d+\]/.test(effect.variableId)) return true;
  const v = resolveEffectVariable(world, effect.variableId);
  const arithmetic = ["add", "subtract", "multiply"].includes(effect.operation);
  if ((v?.type === "string" || v?.type === "boolean") && arithmetic) return false;
  if (v?.type !== "number") return true;
  if (!arithmetic && effect.operation !== "set") return true;
  const value = effect.value;
  return typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/**
 * A recovered write, checked against the world: the target must be a real,
 * AI-writable variable and the value must fit its type. Returns the effect to
 * apply (an `append` on a list becomes a `push`), or null.
 */
function checkRecoveredWrite(world: { variables: Variable[] }, effect: Effect): Effect | null {
  const v = resolveEffectVariable(world, effect.variableId);
  if (!v || v.internal || v.formula || (v.aiAccess ?? "write") !== "write") return null;
  const { operation: op, value } = effect;
  const nested = effect.variableId.includes(".") || /\[\d+\]/.test(effect.variableId);
  const num = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (nested) {
    if (v.type !== "json") return null;
    if (op === "add" || op === "subtract" || op === "multiply") return Number.isFinite(num) ? { ...effect, value: num } : null;
    if (op === "append") return typeof value === "string" ? effect : null;
    return effect;
  }
  switch (v.type) {
    case "number":
      if (op === "set" || op === "add" || op === "subtract" || op === "multiply") return Number.isFinite(num) ? { ...effect, value: num } : null;
      return null;
    case "string":
      if (op === "set" || op === "append") return typeof value === "string" || typeof value === "number" ? { ...effect, value: String(value) } : null;
      return null;
    case "boolean":
      if (op === "toggle") return { ...effect, value: true };
      if (op === "set" && typeof value === "boolean") return effect;
      if (op === "set" && (value === "true" || value === "false")) return { ...effect, value: value === "true" };
      return null;
    case "json":
      if (op === "set") return typeof value === "object" && value !== null ? effect : null;
      if (op === "merge") return isPlainObject(value) ? effect : null;
      if (op === "append") return { ...effect, operation: "push" };
      if (op === "push" || op === "delete") return effect;
      return null;
    default:
      return null;
  }
}

/**
 * Extracts state change directives from LLM output.
 * Format: [id: operation value]
 * Examples: [health: -10], [gold: +50], [location: set "forest"], [hasKey: toggle]
 * Audio: [audio: trackId play], [audio: trackId stop]
 */
export class ResponseParser {
  private pattern: RegExp;
  private audioPattern: RegExp;
  // JSON directives use a bracket-balancing scanner, not a regex — non-greedy
  // regexes mis-terminate on nested `[]`/`{}` inside the value (e.g. `"comments":[]`).
  // Names transliterated into Chinese/Japanese join their parts with a middle
  // dot (艾丝·华伦斯坦, アイズ・ヴァレンシュタイン); a key like that inside a
  // dot-path (`[relations.艾丝·华伦斯坦: +20]`) must still parse, or the tag is
  // left raw in the story. After a dot a key may also hold single spaces
  // (`[relations.Riveria Ljos Alf: +1]`, how English and Spanish cards key
  // people); the first segment never does, so bracketed prose like
  // `[Chapter One: Begin]` is not read as a directive.
  private jsonVarIdPattern = /[\w\p{L}\p{N}$·・-]+(?:\.[\w\p{L}\p{N}$·・-]+(?: [\w\p{L}\p{N}$·・-]+)*)*/u;
  private jsonOps = ["set", "merge", "push", "delete"] as const;

  constructor(pattern?: RegExp) {
    // Both patterns tolerate optional whitespace immediately after `[` and
    // before `]` — LLMs sometimes emit `[ varId: set "x" ]` with padding.
    // Match [id: operation] patterns
    this.pattern =
      pattern ?? /\[\s*([\w\p{L}\p{N}$·・-]+(?:\.[\w\p{L}\p{N}$·・-]+(?: [\w\p{L}\p{N}$·・-]+)*)*):\s*(set|add|subtract|multiply|toggle|append|\+|-|\*)?\s*("(?:[^"\\]|\\.)*"|[^\]"]+)?\s*\]/gu;
    // Match [audio: trackId action] patterns — optional chain:targetId suffix
    this.audioPattern = /\[\s*audio:\s*([\w\p{L}\p{N}-]+)\s+(play|stop|crossfade|volume)(?:\s+([\d.]+))?(?:\s+chain:([\w\p{L}\p{N}-]+))?\s*\]/gu;
  }

  parse(responseText: string, jsonVarId?: string, opts?: ParseOptions): ParseResult {
    const effects: Effect[] = [];
    const audioEffects: AudioEffect[] = [];
    this.pattern.lastIndex = 0;
    this.audioPattern.lastIndex = 0;
    const world = opts?.world;
    const ids: ReadonlySet<string> | undefined = world
      ? new Set(world.variables.map((v) => v.id))
      : opts?.variableIds ? new Set(opts.variableIds) : undefined;
    const lineCtx: BracketLineContext = {
      variableIds: ids,
      protect: (world?.replyRules ?? opts?.replyRules ?? [])
        .filter((r) => r.enabled !== false)
        .map(replyRuleMatcher)
        .filter((re): re is RegExp => re !== null),
    };

    // Strip leaked thinking/reasoning blocks (e.g. Gemini Flash Lite outputs <fiction-mode>...</fiction-mode>)
    const stripped = stripStateReceipts(ThinkingTagFilter.strip(responseText));

    // The speaker tag sits at the very start and must never reach the
    // standard directive pattern below, which would read it as `[speaker: set …]`.
    const speakerTag = parseLeadingSpeakerTag(stripped);

    // `<rationale>` goes whole; `<directive>` / `[state-changes]` wrappers are
    // unwrapped so the scanners below apply what they hold, and the rest of
    // them is dropped from the clean text (see bookkeeping-blocks.ts).
    const unwrapped = unwrapBookkeepingBlocks(speakerTag.text);

    // Extract <UpdateVariable> JSON Patch blocks (SillyTavern compatibility)
    let text = this.extractJsonPatch(unwrapped, effects, jsonVarId ?? "game_state");

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

    // Shield `[image:…]` embeds from the directive scanners below. Both the
    // author-facing URL form and the AI's `[image: handle]` scene directive
    // would otherwise match the standard pattern as `[image: set …]`, get
    // recorded as a bogus effect and vanish from the visible text.
    const imageEmbeds: string[] = [];
    const shield = (match: string) => {
      imageEmbeds.push(match);
      return `\x00IMG${imageEmbeds.length - 1}\x00`;
    };
    if (opts?.shieldImages !== false) text = text.replace(IMAGE_EMBED_RE, shield);
    if (world?.backgrounds?.length && !ids?.has("bg")) text = text.replace(BG_TAG_RE, shield);

    // `[variable: mood: set "angry"]` → `[mood: set "angry"]` before either
    // directive scanner looks at it.
    text = text.replace(DIRECTIVE_VARIABLE_PREFIX_RE, "[");

    // Extract JSON directives with bracket balancing (must come before standard
    // pattern so the bare-word pattern never catches fragments of a JSON value).
    text = this.extractJsonDirectives(text, effects);

    // Then extract standard state change directives
    const unapplied: UnappliedDirective[] = [];
    const scanned = text.replace(this.pattern, (match: string, variableId: string, op?: string, rawValue?: string) => {
      // `[heart: -3, pride: -4]` is two changes, not `-` with "3, pride: -4".
      const chained = rawValue !== undefined && !rawValue.trimStart().startsWith('"') && CHAINED_TAIL_RE.test(rawValue);
      const effect = chained ? null : this.parseDirective(variableId, op, rawValue);
      if (effect && (!world || numberWriteFits(world, effect))) {
        effects.push(effect);
        return "";
      }
      // Taken out of the story either way. With the world, recover what it
      // can (one write per part); a write that does not apply is reported,
      // never silently lost.
      const recovered = world && (chained || !effect) ? this.recoverSpan(match, world, ids) : null;
      if (recovered) effects.push(...recovered.effects);
      if (!recovered?.complete) unapplied.push({ text: match, targets: recovered?.targets ?? spanTargets(match, ids) });
      return "";
    })
      // Strip structural XML tags only when they appear as standalone block-level tags on their own line
      // (safe: won't match words like "summarize" or "optional" in prose)
      .replace(/^\s*<\/?(maintext|option|sum|Analysis|UpdateVariable|JSONPatch|status_current_variable)\s*>\s*$/gim, "");

    // What the scanners could not parse but is still state bookkeeping: a
    // bracket-only line whose key is a variable or a placeholder, or whose
    // value is an operation (directive-lines.ts). Hidden either way; applied
    // when it can be recovered into valid writes, otherwise reported.
    const lines = stripBookkeepingLines(dropMarkedBookkeeping(scanned), lineCtx);
    for (const span of lines.removed) {
      // An echoed `[game-state]` or "no changes" note: nothing was attempted.
      if (isEmptyBookkeepingSpan(span)) continue;
      const recovered = world ? this.recoverSpan(span, world, ids) : { effects: [], complete: false, targets: spanTargets(span, ids) };
      effects.push(...recovered.effects);
      if (!recovered.complete) unapplied.push({ text: span, targets: recovered.targets });
    }

    // `[game-state.location: set "客厅"]`: a placeholder root in front of a
    // real variable. Only rewritten when the id as written resolves to nothing.
    if (world) {
      for (const effect of effects) {
        if (resolveEffectVariable(world, effect.variableId)) continue;
        const bare = stripPlaceholderRoots(effect.variableId, ids);
        if (bare !== effect.variableId && resolveEffectVariable(world, bare)) effect.variableId = bare;
      }
    }

    const cleanText = dropEmptyFences(lines.text)
      .replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n")
      .replace(/\x00IMG(\d+)\x00/g, (_m, idx: string) => imageEmbeds[Number(idx)] ?? "")
      .trim();

    const result: ParseResult = { cleanText, effects, audioEffects };
    if (speakerTag.speaker) result.speaker = speakerTag.speaker;
    if (unapplied.length) result.unapplied = unapplied;
    return result;
  }

  /**
   * Recover the writes in a bookkeeping span the scanners could not parse:
   *   [state: {"location": "x", "mood": "y"}]          → set each key
   *   [state: set {"a": 1}, append {"memory": "m"}]    → each op on each key
   *   [log: append "a", "npcs.x.y": 120]               → one write per part
   *   [player.status: append ", A", append ", B"]      → two appends
   * Every write must hit a real, AI-writable variable with a value of its
   * type. `complete` is false when any part could not be applied.
   */
  private recoverSpan(
    spanText: string,
    world: { variables: Variable[] },
    ids: ReadonlySet<string> | undefined,
  ): { effects: Effect[]; complete: boolean; targets: string[] } {
    const targets = spanTargets(spanText, ids);
    const effects: Effect[] = [];
    let complete = true;
    const patch = jsonPatchSpan(spanText);
    if (patch) {
      for (const p of patch) {
        const variableId = stripPlaceholderRoots(p.path.replace(/^\//, "").replace(/\//g, "."), ids);
        const value = p.value as Effect["value"];
        const num = Number(p.value);
        const effect: Effect | null =
          p.op === "remove" ? { variableId, operation: "delete", value: true }
          : p.op === "delta" ? (Number.isFinite(num) ? { variableId, operation: num >= 0 ? "add" : "subtract", value: Math.abs(num) } : null)
          : p.op === "merge" ? { variableId, operation: "merge", value }
          : value === undefined ? null
          : { variableId, operation: "set", value };
        const checked = effect ? checkRecoveredWrite(world, effect) : null;
        if (checked) effects.push(checked);
        else complete = false;
      }
      return { effects, complete: complete && effects.length > 0, targets: patchTargets(patch, ids) };
    }
    const parsed = spanKey(spanText, ids);
    if (!parsed) return { effects: [], complete: false, targets };
    let target = stripPlaceholderRoots(parsed.key, ids);
    // `{…}` is a batch of variables only after a placeholder (`[state: {…}]`)
    // or a bare key that is no variable at all; after a real variable or a
    // dot-path its keys are that value's own fields.
    const isBatchTarget = (id: string) => isPlaceholderKey(id, ids) || (!id.includes(".") && !resolveEffectVariable(world, id));
    const add = (effect: Effect | null) => {
      const checked = effect ? checkRecoveredWrite(world, effect) : null;
      if (checked) effects.push(checked);
      else complete = false;
    };
    const perKey = (raw: string, operation: Effect["operation"]) => {
      let obj: unknown;
      try { obj = JSON.parse(raw); } catch { complete = false; return; }
      if (!isPlainObject(obj) || !Object.keys(obj).length) { complete = false; return; }
      for (const [key, value] of Object.entries(obj)) {
        add({ variableId: stripPlaceholderRoots(key, ids), operation, value: value as Effect["value"] });
      }
    };

    // One change on one target, with the same meaning as a standalone
    // directive: an operation word, `+N`/`-N`/`*N` (add/subtract/multiply),
    // a `{…}` batch after a placeholder, or a clean value (set).
    const applyOn = (id: string, raw: string) => {
      const op = OP_SEGMENT_RE.exec(raw);
      if (op) {
        const word = op[1]!;
        const rest = (op[2] ?? "").trim();
        if (word === "toggle" && !rest) { add({ variableId: id, operation: "toggle", value: true }); return; }
        if (rest.startsWith("{") && isBatchTarget(id)) {
          perKey(rest, word === "update" || word === "merge" ? "set" : (word as Effect["operation"]));
          return;
        }
        if (word === "update") { complete = false; return; }
        const value = strictValue(rest);
        add(value === undefined ? null : { variableId: id, operation: word as Effect["operation"], value });
        return;
      }
      const short = SHORTHAND_SEGMENT_RE.exec(raw);
      if (short) { add(this.parseDirective(id, short[1], short[2])); return; }
      if (raw.startsWith("{") && isBatchTarget(id)) { perKey(raw, "set"); return; }
      // `[mood | calm]`, `"a.b": 120`: a lone clean value is a set.
      const bare = isPlaceholderKey(id, ids) ? undefined : strictValue(raw);
      if (bare !== undefined) { add({ variableId: id, operation: "set", value: bare }); return; }
      complete = false;
    };

    for (const part of splitTopLevel(parsed.rest)) {
      const s = part.trim();
      if (!s) continue;
      // `append ", b"`, `+5`: another change on the current target.
      if (OP_SEGMENT_RE.test(s) || SHORTHAND_SEGMENT_RE.test(s)) { applyOn(target, s); continue; }
      // `heart: +5`, `"npcs.x.y": 120`: a new target with its change.
      const kv = QUOTED_KEY_SEGMENT_RE.exec(s) ?? BARE_KEY_SEGMENT_RE.exec(s);
      if (kv) {
        target = stripPlaceholderRoots(kv[1]!, ids);
        applyOn(target, kv[2]!.trim());
        continue;
      }
      // `npcs.a.trust +5`, `log append ", x"`: a new target, no colon.
      const spaced = SPACED_TARGET_SEGMENT_RE.exec(s);
      if (spaced) {
        target = stripPlaceholderRoots(spaced[1]!, ids);
        applyOn(target, spaced[2]!.trim());
        continue;
      }
      applyOn(target, s);
    }
    if (!effects.length) complete = false;
    return { effects, complete, targets };
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

    // `+`/`-`/`*` with something that is not a number (`-3, pride: -4`) is
    // not a write; it used to fall through as operation "-" with a string.
    if ((op === "+" || op === "-" || op === "*") && rawValue) return null;

    // Explicit operations: set, add, subtract, multiply, append
    if (op && rawValue) {
      const operation = op as Effect["operation"];
      const value = this.parseValue(rawValue);
      return { variableId, operation, value };
    }

    // [health: 50] — implicit set with a number
    if (!op && rawValue) {
      // `[items: push forest]`, `[rules: update 1 {}]`: an operation this
      // pattern does not take, not a value to set. Not a write.
      if (/^(?:update|merge|push|delete)\s/.test(rawValue)) return null;
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
  tryParseDirectiveBlock(body: string): Effect[] | null {
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
