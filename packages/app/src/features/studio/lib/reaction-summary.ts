import type { Reaction, ReactionEffect, Variable } from "@yumina/engine";

/**
 * A behaviour row's one-line story: when it fires and what it does.
 *
 * "2 effects" told a creator nothing — every behaviour has effects; the
 * question a row exists to answer is WHICH. The summary reads like the thing
 * itself: `每回合 · 好感度+5`, `damage:taken · hp−10 +2`. Operation symbols
 * stay symbolic on purpose — `=`, `+`, `−` need no translation, and the two
 * strings that do (the every-turn label, the if-marker) come in from i18n.
 */

const OP_SYMBOL: Record<string, string> = {
  set: "=",
  add: "+",
  subtract: "−",
  multiply: "×",
  append: "⊕",
  push: "⊕",
  merge: "⊕",
};

/** `inventory.gold[0]` reads as the variable named for `inventory`, with the
 *  rest of the path kept raw — the name is the recognisable part. */
function pathLabel(path: string, variables: Map<string, Variable>): string {
  const head = path.split(/[.[]/, 1)[0] ?? path;
  const rest = path.slice(head.length);
  return (variables.get(head)?.name ?? head) + rest;
}

/** Words for the engine's own paths. Without them a row read
 *  `@prompt.context={{interpolate(vars, …` — the protocol, not the behaviour. */
export interface SystemEffectLabels {
  /** 「告诉 AI」 */
  tellAi?: string;
  /** 「开启词条」 / 「关闭词条」 */
  entryOn?: string;
  entryOff?: string;
  /** 「启用」 / 「停用」 — a variable's enable gate. */
  varOn?: string;
  varOff?: string;
}

/** Prose with its macros read: `{{hp}}` as the variable's name, an expression
 *  in braces as "…". Cut to a row's length. */
function prose(value: unknown, variables: Map<string, Variable>, max = 24): string {
  const text = (typeof value === "string" ? value : "")
    .replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_m, inner: string) =>
      inner === "user" || inner === "char" ? `{{${inner}}}` : variables.get(inner)?.name ?? (/^[\w.-]+$/.test(inner) ? inner : "…"))
    .replace(/\s+/g, " ")
    .trim();
  // Never cut inside a macro: `{{us…` reads as broken code.
  return text.length > max ? `${text.slice(0, max).replace(/\{\{[^}]*$/, "")}…` : text;
}

function systemEffectLabel(effect: ReactionEffect, variables: Map<string, Variable>, labels: SystemEffectLabels): string | null {
  if (effect.type === "emit" || !effect.path.startsWith("@")) return null;
  const path = effect.path;
  if ((path === "@prompt.context" || path.startsWith("@prompt.directive.")) && labels.tellAi) {
    if (path.startsWith("@prompt.directive.") && effect.value === false) return null;
    const said = prose(effect.value, variables);
    return said ? `${labels.tellAi}「${said}」` : labels.tellAi;
  }
  if (path.startsWith("@prompt.entry.") && labels.entryOn && labels.entryOff) {
    return effect.value ? labels.entryOn : labels.entryOff;
  }
  if (path.startsWith("@vars.enabled.") && labels.varOn && labels.varOff) {
    const id = path.slice("@vars.enabled.".length);
    return `${effect.value ? labels.varOn : labels.varOff} ${variables.get(id)?.name ?? id}`;
  }
  return null;
}

function effectLabel(effect: ReactionEffect, variables: Map<string, Variable>, labels: SystemEffectLabels = {}): string {
  const system = systemEffectLabel(effect, variables, labels);
  if (system) return system;
  if (effect.type === "emit") {
    const type = typeof effect.event?.type === "string" ? effect.event.type : "?";
    return `→${type}`;
  }
  const name = pathLabel(effect.path, variables);
  const op = effect.operation ?? "set";
  if (op === "toggle") return `${name}⇄`;
  if (op === "delete") return `${name}✕`;
  const value = effect.valueRandom
    ? "🎲"
    : effect.valueRef
      ? pathLabel(effect.valueRef, variables)
      : typeof effect.value === "object"
        ? "{…}"
        : String(effect.value);
  return `${name}${OP_SYMBOL[op] ?? "·"}${value}`;
}

/** When a behaviour fires, in the row's own shorthand. A threshold watch
 *  reads as its line and the number — `↑40 信任度`, `↓0 血量` — and a
 *  change watch as the number with ±; the raw event name (`state:crossed`)
 *  is the engine's word, and it was what rows used to show. */
export function whenLabel(reaction: Reaction, variables: Map<string, Variable>, everyTurn: string): string {
  const type = reaction.when?.eventType;
  if (type === "turn:complete") return everyTurn;
  const match = (reaction.when?.match ?? {}) as Record<string, { value?: unknown } | undefined>;
  const varId = typeof match.variableId?.value === "string" ? match.variableId.value : null;
  const name = varId ? variables.get(varId)?.name ?? varId : null;
  if (type === "state:crossed" && name) {
    const n = match.threshold?.value;
    const down = match.direction?.value === "falls-below";
    // The line first: a long number name is what the row cuts, not the 40.
    return typeof n === "number" || typeof n === "string" ? `${down ? "↓" : "↑"}${n} ${name}` : name;
  }
  if (type === "state:changed" && name) return `${name} ±`;
  // A button: its row already wears the 按钮动作 chip, so the button is the
  // rest of the sentence. The event id is not something a creator wrote.
  if (type === "action:fired") return typeof match.actionId?.value === "string" ? match.actionId.value : "";
  return type ?? "?";
}

export function reactionSummary(
  reaction: Reaction,
  variables: Map<string, Variable>,
  /** Pass `everyTurn: ""` to omit the when-part for turn:complete — the board
   *  does, because its behaviour rows already wear an "each turn" chip and a
   *  summary that repeats the chip is noise wearing a different font. */
  labels: { everyTurn: string; ifMark: string } & SystemEffectLabels,
): string {
  const when = whenLabel(reaction, variables, labels.everyTurn);
  const guarded = (reaction.conditions?.length ?? 0) > 0 ? labels.ifMark : "";
  const effects = reaction.then ?? [];
  const first = effects[0] ? effectLabel(effects[0], variables, labels) : "";
  const more = effects.length > 1 ? ` +${effects.length - 1}` : "";
  return [when, guarded && `${guarded}`, first && `${first}${more}`]
    .filter(Boolean)
    .join(" · ");
}
