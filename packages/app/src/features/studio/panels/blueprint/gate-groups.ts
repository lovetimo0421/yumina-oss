import { evaluateCondition, type Condition, type GameState, type Variable, type WorldEntry } from "@yumina/engine";

/**
 * A long 条件触发 block as the chapters it is written in.
 *
 * Masterwork cards gate most of their lore on one variable — 卷, Chapter,
 * Season — and the board listed them one by one, sixteen and a fold, so a
 * card of 466 such entries showed nothing of the timeline they make. When
 * most of a block's entries are gated by the same variable, the block is
 * drawn as groups instead: one per span of that variable's values the entries
 * are sent at (卷 3, 卷 18–20), with the rest under 「看别的条件」.
 *
 * Whether an entry is sent at a value is read with the engine's own
 * evaluator, so the groups and the preview say what play does.
 */

export type GateValue = number | string | boolean;

export interface GateGroup {
  /** Stable for the same span: `gate:` + which values it is sent at. */
  id: string;
  /** Sent at `domain[i]`? null: its gate is not this variable alone. */
  on: boolean[] | null;
  entryIds: string[];
}

export interface GateGrouping {
  variableId: string;
  domain: GateValue[];
  /** Where the card starts: the variable's default, if it is in the domain. */
  defaultIndex: number;
  groups: GateGroup[];
  /** Entries whose other conditions decide too: "may be sent", never "is". */
  alsoGated: ReadonlySet<string>;
}

/** Only a block that would fold is worth regrouping. */
export const GATE_MIN_ENTRIES = 17;
/** The share of a block's entries one variable must gate. */
const DOMINANT_SHARE = 0.6;
/** More values than this is not a timeline to scrub through. */
const MAX_DOMAIN = 40;

function at(variableId: string, value: GateValue): GameState {
  return { worldId: "", variables: { [variableId]: value } as GameState["variables"], turnCount: 0, metadata: {} };
}

function domainOf(variable: Variable, conditions: Condition[]): GateValue[] | null {
  if (variable.type === "boolean") return [false, true];
  if (variable.type === "number") {
    // Only a run of whole values reads as a timeline. Thresholds far apart
    // (好感度 > 100, > 500) would be named by the points sampled, not by
    // what they say, so such a block keeps its rows.
    const values = conditions.map((c) => (typeof c.value === "number" ? c.value : Number(c.value))).filter(Number.isFinite);
    const bounds = [variable.min, variable.max, typeof variable.defaultValue === "number" ? variable.defaultValue : undefined]
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const all = [...values, ...bounds];
    if (!all.length || !all.every(Number.isInteger)) return null;
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    return hi - lo + 1 <= MAX_DOMAIN ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : null;
  }
  if (variable.type === "string") {
    // "is" / "is not" are decided by the values named; "contains" is not.
    if (!conditions.every((c) => c.operator === "eq" || c.operator === "neq")) return null;
    const distinct = [...new Set([variable.defaultValue, ...conditions.map((c) => c.value)]
      .filter((v): v is string => typeof v === "string"))];
    return distinct.length <= MAX_DOMAIN ? distinct : null;
  }
  return null;
}

export function gateGrouping(entries: readonly WorldEntry[], variables: readonly Variable[]): GateGrouping | null {
  if (entries.length < GATE_MIN_ENTRIES) return null;
  // Folders are the author's own grouping; they win.
  if (entries.some((e) => e.folderId)) return null;
  const uses = new Map<string, number>();
  for (const e of entries) for (const id of new Set((e.conditions ?? []).map((c) => c.variableId))) uses.set(id, (uses.get(id) ?? 0) + 1);
  const [variableId, count] = [...uses.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!variableId || !count || count / entries.length < DOMINANT_SHARE) return null;
  // A path into a json variable, or a variable the card does not have, is
  // not something one value can be slid along.
  const variable = variables.find((v) => v.id === variableId);
  if (!variable || /[.[]/.test(variableId)) return null;
  const gating = entries.flatMap((e) => (e.conditions ?? []).filter((c) => c.variableId === variableId && c.valueRef === undefined));
  const domain = domainOf(variable, gating);
  if (!domain || domain.length < 2) return null;

  const alsoGated = new Set<string>();
  const byKey = new Map<string, GateGroup>();
  for (const e of entries) {
    const mine = (e.conditions ?? []).filter((c) => c.variableId === variableId);
    const others = (e.conditions ?? []).length - mine.length;
    let on: boolean[] | null = null;
    // Under 「任一」 another condition can send it whatever this one says:
    // the variable alone does not place it.
    // Compared with another variable, the value alone does not decide either.
    if (mine.length && !mine.some((c) => c.valueRef !== undefined) && !(e.conditionLogic === "any" && others > 0)) {
      on = domain.map((value) => (e.conditionLogic === "any"
        ? mine.some((c) => evaluateCondition(at(variableId, value), c))
        : mine.every((c) => evaluateCondition(at(variableId, value), c))));
      if (others > 0) alsoGated.add(e.id);
    }
    const key = on ? on.map((b) => (b ? "1" : "0")).join("") : "other";
    const group = byKey.get(key) ?? { id: `gate:${key}`, on, entryIds: [] };
    group.entryIds.push(e.id);
    byKey.set(key, group);
  }
  const groups = [...byKey.values()];
  if (groups.length < 2) return null;
  const first = (g: GateGroup) => (g.on ? (g.on.indexOf(true) === -1 ? 900 : g.on.indexOf(true)) : 999);
  const width = (g: GateGroup) => (g.on ? g.on.filter(Boolean).length : 0);
  groups.sort((a, b) => first(a) - first(b) || width(a) - width(b));
  const defaultIndex = Math.max(0, domain.findIndex((v) => v === variable?.defaultValue));
  return { variableId, domain, defaultIndex, groups, alsoGated };
}

/** What a group's header says, as parts a translation can put together. */
export type GateLabel =
  | { kind: "other" }
  | { kind: "never" }
  | { kind: "always" }
  | { kind: "one"; value: GateValue }
  | { kind: "range"; from: GateValue; to: GateValue }
  | { kind: "list"; values: GateValue[] };

export function gateLabel(group: GateGroup, domain: readonly GateValue[]): GateLabel {
  if (!group.on) return { kind: "other" };
  const idx = group.on.flatMap((b, i) => (b ? [i] : []));
  if (!idx.length) return { kind: "never" };
  if (idx.length === domain.length) return { kind: "always" };
  if (idx.length === 1) return { kind: "one", value: domain[idx[0]!]! };
  const contiguous = idx[idx.length - 1]! - idx[0]! === idx.length - 1;
  const numeric = typeof domain[0] === "number";
  if (contiguous && numeric) return { kind: "range", from: domain[idx[0]!]!, to: domain[idx[idx.length - 1]!]! };
  return { kind: "list", values: idx.map((i) => domain[i]!) };
}
