import type { Effect, GameState, WorldDefinition } from "../types/index.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { isAiWritable } from "../state/variable-activation.js";
import { ResponseParser, type ParseResult } from "./response-parser.js";
import { StructuredResponseParser } from "./structured-response-parser.js";
import { ThinkingTagFilter } from "./thinking-tag-filter.js";
import { stripStateReceipts } from "./state-receipt.js";
import { parseLeadingSpeakerTag } from "../prompts/speaker-tag.js";

export interface StateDiagnostic { code: string; start?: number; end?: number }
export interface GuardedParseResult extends ParseResult {
  outcome: "valid-updates" | "explicit-none" | "not-required" | "invalid";
  diagnostics: StateDiagnostic[];
  declaredCount?: number;
  repaired: boolean;
}

const operations = new Set(["set", "add", "subtract", "multiply", "toggle", "append", "merge", "push", "delete"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unsafeKey = (key: string) => ["__proto__", "prototype", "constructor"].includes(key);
function safeValue(value: unknown): boolean {
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return false;
  if (Array.isArray(value)) return value.every(safeValue);
  if (isObject(value)) return Object.entries(value).every(([key, v]) => !unsafeKey(key) && safeValue(v));
  return value === null || ["number", "string", "boolean"].includes(typeof value);
}

/** Engine authority for guarded AI input. Access is checked against the immutable
 * pre-AI state; values/containers are checked sequentially on a private engine. */
export function validateAiBatch(world: WorldDefinition, state: GameState, batch: Effect[]): { effects: Effect[]; diagnostics: StateDiagnostic[] } {
  const engine = new GameStateManager(world, structuredClone(state));
  const effects: Effect[] = [];
  const diagnostics: StateDiagnostic[] = [];
  for (const raw of batch) {
    const reject = (code: string) => diagnostics.push({ code });
    if (!raw || typeof raw.variableId !== "string" || !operations.has(raw.operation) || !safeValue(raw.value) || raw.valueRef !== undefined) {
      reject("invalid_operation"); continue;
    }
    const path = raw.variableId.replace(/\[(\d+)\]/g, ".$1").split(".");
    if (path.some((part) => !part || unsafeKey(part))) { reject("unsafe_path"); continue; }
    const root = world.variables.find((v) => v.id === path[0]) ?? [...world.variables].reverse().find((v) => v.name === path[0]);
    if (!root) { reject("unknown_variable"); continue; }
    if (!isAiWritable(root, state)) { reject("not_writable"); continue; }
    path[0] = root.id;
    const effect = { ...raw, variableId: path.join(".") };
    let old: unknown = engine.get(root.id);
    let badContainer = false;
    if (path.length > 1) {
      if (root.type !== "json" || old === null || typeof old !== "object") { reject("invalid_container"); continue; }
      for (let i = 1; i < path.length; i++) {
        if (old !== undefined && old !== null && typeof old !== "object") { badContainer = true; break; }
        if (Array.isArray(old) && (!/^(0|[1-9]\d*)$/.test(path[i]!) || Number(path[i]) > old.length)) { badContainer = true; break; }
        old = old == null ? undefined : (old as Record<string, unknown>)[path[i]!];
      }
    }
    if (badContainer) { reject("invalid_container"); continue; }
    const value = effect.value;
    let valid = true;
    switch (effect.operation) {
      case "set": valid = path.length > 1 || root.type === "json" || typeof value === root.type; break;
      case "add": case "subtract": case "multiply":
        valid = typeof old === "number" && typeof value === "number" && Number.isFinite(effect.operation === "add" ? old + value : effect.operation === "subtract" ? old - value : old * value);
        break;
      case "toggle": valid = typeof old === "boolean"; break;
      case "append": valid = typeof old === "string" && typeof value === "string"; break;
      case "merge": valid = isObject(old) && isObject(value); break;
      case "push": valid = Array.isArray(old); break;
      case "delete": valid = path.length > 1 || (isObject(old) && typeof value === "string" && !unsafeKey(value)) || (Array.isArray(old) && Number.isInteger(value) && Number(value) >= 0); break;
    }
    if (!valid) { reject("incompatible_value"); continue; }
    // Nested engine historically treats these operations as set. Normalize the
    // operand to preserve their intended meaning without changing legacy callers.
    if (path.length > 1 && ["multiply", "toggle", "append"].includes(effect.operation)) {
      effect.value = effect.operation === "multiply" ? Number(old) * Number(value) : effect.operation === "toggle" ? !old : String(old) + String(value);
      effect.operation = "set";
    }
    try {
      engine.applyEffects([effect]);
      if (engine.drainRejectedWrites().length) { reject("incompatible_value"); continue; }
      effects.push(effect);
    }
    catch { reject("invalid_container"); }
  }
  return { effects: diagnostics.length ? [] : effects, diagnostics };
}

/** Additive strict entry point. Existing permissive parsers remain unchanged. */
export function parseGuardedResponse(raw: string, world: WorldDefinition, state: GameState): GuardedParseResult {
  const speakerTag = parseLeadingSpeakerTag(ThinkingTagFilter.strip(raw));
  const text = speakerTag.text;
  const legacy = new ResponseParser();
  const structured = new StructuredResponseParser();
  const diagnostics: StateDiagnostic[] = [];
  let parsed: ParseResult = { cleanText: stripStateReceipts(text), effects: [], audioEffects: [] };
  let declaredCount: number | undefined;
  let receipt: "none" | "updated" | undefined;
  let repaired = false;
  const fail = (code: string, start?: number, end?: number) => diagnostics.push({ code, start, end });

  if (structured.isStructuredResponse(text) || world.settings?.structuredOutput) {
    try {
      const json = text.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```$/, "");
      const envelope: unknown = JSON.parse(json);
      if (!isObject(envelope) || typeof envelope.narrative !== "string") throw new Error();
      parsed = structured.parse(json);
      const changes = envelope.stateChanges;
      const status = envelope.status;
      if (status !== undefined && status !== "none" && status !== "updated") fail("invalid_receipt");
      if (!Array.isArray(changes) && !isObject(changes)) fail("missing_state_changes");
      else {
        declaredCount = Array.isArray(changes) ? changes.length : Object.keys(changes).length;
        if (declaredCount !== parsed.effects.length) fail("invalid_state_member");
        // Empty data is not an acknowledgement. Keep nonempty legacy envelopes
        // compatible, but require the designated flag for an intentional no-op.
        if (status === "none") {
          receipt = "none";
          if (declaredCount !== 0) fail("contradictory_none");
        } else if (declaredCount === 0) {
          fail(status === "updated" ? "count_mismatch" : "missing_receipt");
        } else {
          receipt = "updated";
        }
      }
    } catch {
      // Display-only recovery of a COMPLETE quoted narrative. This must never
      // turn a lossy JSON repair into a successful acknowledgement.
      const narrative = /"narrative"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
      parsed.cleanText = "";
      try { if (narrative) parsed.cleanText = JSON.parse(narrative[1]!) as string; }
      catch { /* An invalid escape is not a recoverable complete narrative. */ }
      fail("incomplete_json");
    }
  } else {
    // Remove only actual standalone, unfenced receipt lines. Quoted/examples
    // cannot acknowledge a turn. Malformed tails are diagnostics, not none.
    let inFence = false;
    let offset = 0;
    const receipts: Array<{ raw: string; start: number; end: number }> = [];
    for (const line of text.split(/\n/)) {
      if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
      if (!inFence && /^[\t ]*<yumina-state\b/.test(line)) receipts.push({ raw: line.trim(), start: offset, end: offset + line.length });
      offset += line.length + 1;
    }
    if (receipts.length !== 1) fail(receipts.length ? "duplicate_receipt" : "missing_receipt");
    const marker = receipts[0];
    if (marker) {
      // A receipt is metadata, not a boundary that can hide later commands.
      // Relocate only a single updated marker across a validated command-only
      // tail. Reparse the WHOLE batch to retain count/type/access guarantees.
      if (receipts.length === 1 && text.slice(marker.end).trim() && /^<yumina-state\s+version="1"\s+status="updated"\s+count="[1-9]\d*"\s*\/>$/.test(marker.raw)) {
        const tail = text.slice(marker.end);
        const tailCheck = parseGuardedResponse(`${tail}\n${marker.raw}`, world, state);
        // Tail parsing is only a prose check: prefix commands may create the
        // containers it needs. Semantic validation belongs to the whole batch.
        if (!tailCheck.cleanText.trim()) {
          const relocated = parseGuardedResponse(`${text.slice(0, marker.start)}${tail}\n${marker.raw}`, world, state);
          if (relocated.outcome === "valid-updates") return { ...relocated, ...(speakerTag.speaker ? { speaker: speakerTag.speaker } : {}), repaired: true };
        }
      }
      if (text.slice(marker.end).trim()) fail("nonterminal_receipt");
      const match = /^<yumina-state\s+version="1"\s+status="(none|updated)"(?:\s+count="(0|[1-9]\d*)")?\s*\/>$/.exec(marker.raw);
      if (!match || (match[1] === "none" && match[2] !== undefined) || (match[1] === "updated" && match[2] === undefined)) fail("invalid_receipt");
      else { receipt = match[1] as "none" | "updated"; declaredCount = match[2] === undefined ? 0 : Number(match[2]); }
    }
    // Invalid marker placement must not discard the rest of the frozen story
    // or conceal commands from validation/correction.
    let body = marker ? text.slice(0, marker.start) + text.slice(marker.end) : text;
    for (const malformed of body.matchAll(/\[\s*([^\s\]:]+)\s+(set|add|subtract|multiply|toggle|append|merge|push|delete)\b[^\n]*/g)) {
      if (world.variables.some((v) => v.id === malformed[1] || v.name === malformed[1])) fail("missing_colon", malformed.index, malformed.index! + malformed[0].length);
    }
    const effects: Effect[] = [];
    // Validate entire compatibility blocks before the legacy adapter can drop
    // a bad member. Keep their existing normalization, not another patch engine.
    body = body.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, (block, start: number) => {
      try {
        const patch = /<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/i.exec(block);
        const data: unknown = JSON.parse(patch?.[1] ?? "");
        if (!Array.isArray(data) || data.some((p) => !isObject(p) || typeof p.path !== "string" || !p.path.startsWith("/") || !["replace", "insert", "delta", "remove"].includes(String(p.op)) || (p.op !== "remove" && !safeValue(p.value)))) throw new Error();
        const root = world.variables.find((v) => v.type === "json" && (v.name === "game_state" || v.id === "game_state"))?.id ?? world.variables.find((v) => v.type === "json")?.id ?? "game_state";
        const result = legacy.parse(block, root);
        if (result.effects.length !== data.length) throw new Error();
        effects.push(...result.effects);
      } catch { fail("invalid_patch", start, start + block.length); }
      return "";
    });
    if (/<\/?(?:UpdateVariable|JSONPatch)\b/i.test(body)) fail("incomplete_patch");
    body = body.replace(/```[^\n]*\n([\s\S]*?)```/g, (block, inside: string, start: number) => {
      const result = legacy.tryParseDirectiveBlock(inside);
      if (result) { effects.push(...result); return ""; }
      // A receipt inside a code example is not an acknowledgement. JSON that
      // resembles a directive batch cannot be silently ignored either.
      if (/"[^"\n]+"\s*:\s*"(?:(?:set|add|subtract|push|merge|delete|toggle|append|multiply)\b|[+*-]\d)/.test(block)) fail("invalid_fenced_batch", start, start + block.length);
      return block;
    });
    const header = /\[\s*([\w\p{L}\p{N}.$-]+(?:\[\d+\][\w\p{L}\p{N}.$-]*)*):\s*/gu;
    let cursor = 0;
    let visible = "";
    let match: RegExpExecArray | null;
    while ((match = header.exec(body))) {
      if (match.index < cursor || match[1] === "audio") continue;
      visible += body.slice(cursor, match.index);
      const start = match.index;
      let end = header.lastIndex;
      let quoted = false;
      let escape = false;
      const stack: string[] = [];
      for (; end < body.length; end++) {
        const ch = body[end]!;
        if (escape) { escape = false; continue; }
        if (quoted && ch === "\\") { escape = true; continue; }
        if (ch === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if (ch === "\n" && stack.length === 0) break;
        if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
        else if (ch === "]" && stack.length === 0) break;
        else if (ch === "}" || ch === "]") {
          if (stack.pop() !== ch) { fail("invalid_delimiter", start, end); break; }
        }
      }
      const payload = body.slice(header.lastIndex, end).trim();
      let complete = body[end] === "]" && !quoted && !stack.length;
      if (!complete && !quoted && !stack.length) {
        // Only close a missing OUTER bracket around an already complete JSON
        // scalar/container or toggle. Bare strings/partial numbers are ambiguous.
        const value = /^(?:set|add|subtract|multiply|append|merge|push|delete|[+*-])\s*([\s\S]+)$/.exec(payload)?.[1];
        try {
          if (payload !== "toggle") JSON.parse(value ?? "");
          complete = true; repaired = true;
        } catch { /* request correction */ }
      }
      const normalizedId = match[1]!.replace(/\[(\d+)\]/g, ".$1");
      const token = `[${normalizedId}: ${payload}]`;
      const result = legacy.parse(token);
      if (!complete || result.effects.length !== 1) fail("malformed_directive", start, end);
      else effects.push(...result.effects);
      cursor = end + (body[end] === "]" ? 1 : 0);
      header.lastIndex = cursor;
    }
    visible += body.slice(cursor);
    const audio = legacy.parse(visible);
    parsed = { cleanText: audio.cleanText, effects, audioEffects: audio.audioEffects };
    if (receipt === "none" && effects.length) fail("contradictory_none");
    if (receipt === "updated" && (!effects.length || declaredCount !== effects.length)) fail("count_mismatch");
  }
  const checked = validateAiBatch(world, state, parsed.effects);
  diagnostics.push(...checked.diagnostics);
  const required = world.variables.some((v) => isAiWritable(v, state));
  // No writable state requires no model receipt, but never accepts rogue writes.
  const relevant = !required && !parsed.effects.length ? diagnostics.filter((d) => !["missing_receipt", "missing_state_changes"].includes(d.code)) : diagnostics;
  return {
    ...parsed, effects: relevant.length ? [] : checked.effects,
    ...(speakerTag.speaker ? { speaker: speakerTag.speaker } : {}),
    cleanText: stripStateReceipts(parsed.cleanText), diagnostics: relevant,
    outcome: relevant.length ? "invalid" : !required ? "not-required" : receipt === "none" ? "explicit-none" : "valid-updates",
    declaredCount, repaired,
  };
}
