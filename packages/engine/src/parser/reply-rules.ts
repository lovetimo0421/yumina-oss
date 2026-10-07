import type { Effect, WorldDefinition } from "../types/index.js";

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

function matcher(rule: ReplyRule): RegExp | null {
  if ("tag" in rule.match) {
    const tag = rule.match.tag.trim();
    if (!tag) return null;
    const t = escape(tag);
    return new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>|【${t}】([\\s\\S]*?)【\\/${t}】|\\[${t}\\]([\\s\\S]*?)\\[\\/${t}\\]`, "g");
  }
  try {
    const re = new RegExp(rule.match.pattern, "g");
    return re;
  } catch {
    return null;
  }
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
    const re = matcher(rule);
    if (!re) continue;
    const found: string[] = [];
    result.text.replace(re, (whole: string, ...groups: unknown[]) => {
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
          const op = route.op ?? "set";
          result.effects.push({ variableId: v.id, operation: op, value: op === "set" && v.type === "number" ? Number(content) : content });
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
