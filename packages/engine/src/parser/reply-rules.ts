import type { Effect, Variable, WorldDefinition } from "../types/index.js";

/**
 * 回复处理: rules that take tagged blocks out of the AI's reply.
 *
 * About 160 published cards parse a status block (`<状态>HP:62 地点:地下城</状态>`)
 * out of the reply in their interface code, dozens turn `<选项>` into buttons,
 * hide `<think>`, or route a forum update to a panel. A rule says what to
 * catch, whether the player still sees it, and where its contents go:
 *   - "fields": each `名字: 值` line (or `名字:值` pair) into the variable of
 *     that name (or id),
 *   - a variable (the whole block: set, append, or push to a list),
 *   - a story event (behaviours and `api.onStoryEvent` hear it),
 *   - an interface channel (`api.onAiOutput(channel, cb)` hears the text).
 */
export interface ReplyRule {
  id: string;
  name?: string;
  enabled?: boolean;
  /** `<tag>…</tag>` (also `【tag】…【/tag】`), or a regex whose first group
   *  is the content (the whole match when it has none). */
  match: { tag: string } | { pattern: string };
  /** Take it out of the text the player reads. */
  hide?: boolean;
  to?: ReplyRuleRoute[];
}

export type ReplyRuleRoute =
  | { kind: "fields" }
  | { kind: "variable"; variableId: string; op?: "set" | "append" | "push" }
  | { kind: "event"; name?: string }
  | { kind: "channel"; channel: string };

export interface ReplyRulesResult {
  text: string;
  effects: Effect[];
  events: string[];
  channels: Array<{ channel: string; text: string; rule: string }>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a rule catches. The response parser also uses it, so bracket lines a
 *  card's rule is waiting for are never hidden as state bookkeeping. */
export function replyRuleMatcher(rule: ReplyRule): RegExp | null {
  if ("tag" in rule.match) {
    const tag = rule.match.tag.trim();
    if (!tag) return null;
    const t = escape(tag);
    return new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>|【${t}】([\\s\\S]*?)【\\/${t}】|\\[${t}\\]([\\s\\S]*?)\\[\\/${t}\\]`, "g");
  }
  // An empty pattern matches between every two characters: routed to a
  // channel, one reply became a message per character. It catches nothing.
  if (!rule.match.pattern.trim()) return null;
  try {
    const re = new RegExp(rule.match.pattern, "g");
    return re;
  } catch {
    return null;
  }
}

type VariableOp = NonNullable<Extract<ReplyRuleRoute, { kind: "variable" }>["op"]>;

/**
 * What a whole block can do to a variable of each type. A block is text: it
 * can be a number's new value (read as a number), a switch's (read as yes or
 * no), a text's new value or its next line, or the next item on a list. It
 * cannot be "set" over a list — that replaced the list with a string — unless
 * the block is itself JSON. The first is what a new route does.
 */
export function replyRouteOps(type: Variable["type"]): VariableOp[] {
  switch (type) {
    case "number":
    case "boolean":
      return ["set"];
    case "string":
      return ["set", "append"];
    default:
      return ["push", "set"];
  }
}

/** A block read as a number the way a status line writes one ("62", "HP 62/100" → 62). */
const readNumber = (raw: string): number => {
  const direct = Number(raw.trim());
  if (raw.trim() !== "" && Number.isFinite(direct)) return direct;
  const m = /[-+]?\d+(?:\.\d+)?/.exec(raw);
  return m ? Number(m[0]) : NaN;
};
const readBoolean = (raw: string) => /^(true|yes|是|对|1)$/i.test(raw.trim());

/** One whole block into one variable, as its type can take it; null when it
 *  cannot (a number block with no number in it, a "set" of a list that is
 *  not JSON). Routes saved before the choices were typed carry ops their
 *  variable cannot take, and are read as the nearest one it can. */
function blockEffect(v: Variable, op: VariableOp | undefined, content: string): Effect | null {
  if (v.type === "number") {
    const value = readNumber(content);
    return Number.isFinite(value) ? { variableId: v.id, operation: "set", value } : null;
  }
  if (v.type === "boolean") return { variableId: v.id, operation: "set", value: readBoolean(content) };
  if (v.type === "string") return { variableId: v.id, operation: op === "append" || op === "push" ? "append" : "set", value: content };
  // A list or object: a JSON block replaces it; anything else is one more item.
  if (op !== "push") {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed !== null && typeof parsed === "object") return { variableId: v.id, operation: "set", value: parsed as Effect["value"] };
    } catch { /* not JSON: an item, below */ }
    if (op === "set") return null;
  }
  return { variableId: v.id, operation: "push", value: content };
}

/** `HP: 62`, `地点：地下城 | 时间：夜` — the pairs inside a block. */
export function readPairs(block: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of block.split(/\n|[|｜;；]/)) {
    const m = /^\s*([^:：=]{1,40}?)\s*[:：=]\s*(.+?)\s*$/.exec(part);
    if (m) out.push([m[1]!.trim(), m[2]!.trim()]);
  }
  return out;
}

export function applyReplyRules(world: Pick<WorldDefinition, "replyRules" | "variables">, text: string): ReplyRulesResult {
  const rules = (world.replyRules ?? []).filter((r) => r.enabled !== false);
  const result: ReplyRulesResult = { text, effects: [], events: [], channels: [] };
  if (rules.length === 0 || !text) return result;
  const vars = world.variables ?? [];
  const varOf = (key: string) => vars.find((v) => v.id === key || v.name === key);

  for (const rule of rules) {
    const re = replyRuleMatcher(rule);
    if (!re) continue;
    const found: string[] = [];
    result.text.replace(re, (whole: string, ...groups: unknown[]) => {
      // A pattern that can match nothing (`x*`) matches between every two
      // characters; those empty matches are not blocks.
      if (whole === "") return whole;
      const captured = groups.slice(0, -2).find((g) => typeof g === "string") as string | undefined;
      found.push((captured ?? whole).trim());
      return whole;
    });
    if (found.length === 0) continue;
    if (rule.hide) result.text = result.text.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
    for (const content of found) {
      for (const route of rule.to ?? []) {
        if (route.kind === "fields") {
          for (const [key, raw] of readPairs(content)) {
            const v = varOf(key);
            if (!v) continue;
            const value = v.type === "number" ? Number(raw.replace(/[^\d.+-]/g, "")) : v.type === "boolean" ? /^(true|yes|是|对|1)$/i.test(raw) : raw;
            if (v.type === "number" && !Number.isFinite(value as number)) continue;
            result.effects.push({ variableId: v.id, operation: "set", value: value as Effect["value"] });
          }
        } else if (route.kind === "variable") {
          const v = varOf(route.variableId);
          if (!v) continue;
          const effect = blockEffect(v, route.op, content);
          if (effect) result.effects.push(effect);
        } else if (route.kind === "event") {
          const name = route.name?.trim() || content.split("\n")[0]!.trim().slice(0, 120);
          if (name) result.events.push(name);
        } else if (route.kind === "channel" && route.channel.trim()) {
          result.channels.push({ channel: route.channel.trim(), text: content, rule: rule.name || rule.id });
        }
      }
    }
  }
  return result;
}
