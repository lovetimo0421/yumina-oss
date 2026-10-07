import { checkConditions, evaluateCondition, isMemberActive, type Condition, type GameState, type Reaction, type Rule, type Variable, type WorldDefinition } from "@yumina/engine";
import type { RuntimeRecord, RuntimeTrace } from "./runtime-records";

/** One playtest result turned into "what moved, who moved it, what held the
 *  rest back". Every reason comes from the server trace or from re-reading the
 *  card against the state the server returned — nothing is guessed. */

export type ChangeSource =
  | { kind: "ai"; repaired: boolean }
  | { kind: "judge"; confidence: number | null }
  | { kind: "rule"; ids: string[] }
  | { kind: "setup" | "settle" | "action" | "unknown" };

export interface ChangedRow {
  rootId: string;
  /** Dot-path below the root, "" for the whole variable. */
  subPath: string;
  oldValue: unknown;
  newValue: unknown;
  delta: number | null;
  source: ChangeSource;
}

export type HeldReason =
  | { kind: "dropped"; reason: RuntimeTrace["dropped"][number]["reason"] }
  | { kind: "rejected" }
  | { kind: "judge"; chosen: string | number | boolean | null; confidence: number; reason?: string }
  /** The AI wrote it, but to the value it already had. */
  | { kind: "ai-same" }
  | { kind: "ai-silent" }
  | { kind: "rules-only" };

export interface HeldRow { rootId: string; value: unknown; reason: HeldReason }

export type RuleStatus =
  | { kind: "fired" }
  | { kind: "disabled" }
  | { kind: "inactive" }
  | { kind: "unmet" }
  | { kind: "stopped" }
  | { kind: "cooldown"; turnsLeft: number }
  | { kind: "maxed"; count: number }
  /** Every gate passed in the returned state: the roll or the moment decided. */
  | { kind: "chance"; percent: number }
  | { kind: "timing"; trigger: TriggerShape };

export type TriggerShape =
  | { kind: "every-turn" }
  | { kind: "every-n"; n: number; next: number }
  /** A watch on one number's line: with the number and the line known, the
   *  playtest can say how far off it is, as it does for a condition. */
  | { kind: "crossing"; watch?: { variableId: string; threshold: number; down: boolean } }
  | { kind: "player-words" }
  | { kind: "ai-words" }
  | { kind: "action" }
  | { kind: "other" };

export interface RuleProgress {
  variableId: string;
  current: number;
  target: number;
  /** Signed distance still to go (positive = needs to rise). */
  remaining: number;
  /** Turns at the recent pace, null when it is not moving toward the target. */
  eta: number | null;
}

export interface RuleRow { id: string; name: string; status: RuleStatus; progress: RuleProgress | null }

export interface TurnExplanation {
  changed: ChangedRow[];
  held: HeldRow[];
  rules: RuleRow[];
}

const rootOf = (id: string) => id.split(/[.[]/)[0]!;

function sourceFor(record: RuntimeRecord, index: number, rootId: string): ChangeSource {
  if (record.kind === "action") return { kind: "action" };
  const raw = record.trace?.sources[index];
  if (!raw) return { kind: "unknown" };
  if (raw.kind === "ai") return { kind: "ai", repaired: record.repaired };
  if (raw.kind === "judge") {
    const verdict = record.trace?.judge.find((j) => j.variableId === rootId);
    return { kind: "judge", confidence: verdict?.confidence ?? null };
  }
  if (raw.kind === "rule") return { kind: "rule", ids: raw.ids ?? [] };
  return { kind: raw.kind };
}

/** What the author expects to move: not engine bookkeeping, and not what
 *  the player filled in before the story (a 选开局 / 建档 page's answers). */
function watched(variable: Variable): boolean {
  return !variable.internal && variable.type !== "json" && variable.scope !== "setup";
}

function heldReason(variable: Variable, trace: RuntimeTrace | null): HeldReason | null {
  if (!trace) return null;
  const dropped = trace.dropped.find((d) => rootOf(d.variableId) === variable.id);
  if (dropped) return { kind: "dropped", reason: dropped.reason };
  if (trace.rejected.some((id) => rootOf(id) === variable.id)) return { kind: "rejected" };
  const verdict = trace.judge.find((j) => j.variableId === variable.id);
  if (verdict) return { kind: "judge", chosen: verdict.chosen, confidence: verdict.confidence, ...(verdict.reason ? { reason: verdict.reason } : {}) };
  if (trace.aiWrote.includes(variable.id)) return { kind: "ai-same" };
  if ((variable.aiAccess ?? "write") !== "write") return { kind: "rules-only" };
  return { kind: "ai-silent" };
}

type Behavior = { id: string; name: string; enabled: boolean; conditions: Condition[]; conditionLogic: "all" | "any";
  stopConditions?: Condition[]; cooldownTurns?: number; maxFireCount?: number; chance?: number; worldbookId?: string;
  trigger: TriggerShape };

function triggerOfReaction(reaction: Reaction, turnCount: number): TriggerShape {
  const legacy = reaction.when._legacyTrigger;
  if (legacy) return triggerOfRule({ trigger: legacy } as Rule, turnCount);
  const type = reaction.when.eventType;
  if (type === "turn:complete") {
    const every = reaction.when.match?.turnCount;
    if (every && (every.operator as string) === "every") {
      const n = Number(every.value);
      if (Number.isFinite(n) && n > 0) return { kind: "every-n", n, next: (Math.floor(turnCount / n) + 1) * n };
    }
    return { kind: "every-turn" };
  }
  if (type === "state:crossed") {
    const match = (reaction.when.match ?? {}) as Record<string, { value?: unknown } | undefined>;
    const variableId = match.variableId?.value;
    const threshold = Number(match.threshold?.value);
    return typeof variableId === "string" && Number.isFinite(threshold)
      ? { kind: "crossing", watch: { variableId, threshold, down: match.direction?.value === "falls-below" } }
      : { kind: "crossing" };
  }
  if (type === "message:user") return { kind: "player-words" };
  if (type === "message:ai") return { kind: "ai-words" };
  if (type.startsWith("action")) return { kind: "action" };
  return { kind: "other" };
}

function triggerOfRule(rule: Pick<Rule, "trigger">, turnCount: number): TriggerShape {
  const t = rule.trigger;
  switch (t?.type) {
    case "keyword": return { kind: "player-words" };
    case "ai-keyword": return { kind: "ai-words" };
    case "variable-crossed": return { kind: "crossing" };
    case "action": return { kind: "action" };
    case "turn-count":
      if (t.everyNTurns && t.everyNTurns > 0) return { kind: "every-n", n: t.everyNTurns, next: (Math.floor(turnCount / t.everyNTurns) + 1) * t.everyNTurns };
      return { kind: "other" };
    default: return { kind: "every-turn" };
  }
}

function behaviors(world: WorldDefinition, turnCount: number): Behavior[] {
  return [
    ...(world.reactions ?? []).map((r) => ({ ...r, trigger: triggerOfReaction(r, turnCount) })),
    ...(world.rules ?? []).map((r) => ({ ...r, stopConditions: undefined, trigger: triggerOfRule(r, turnCount) })),
  ];
}

function readNumber(state: GameState, path: string): number | null {
  let node: unknown = state.variables;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "number" ? node : null;
}

/** Recent per-turn movement of one value, from the records before this one. */
function pace(history: RuntimeRecord[], variableId: string): number | null {
  const values = history
    .filter((r) => r.kind !== "restore" && r.state)
    .slice(-6)
    .map((r) => readNumber(r.state!, variableId))
    .filter((v): v is number => v !== null);
  if (values.length < 2) return null;
  return (values[values.length - 1]! - values[0]!) / (values.length - 1);
}

function progressOf(behavior: Behavior, state: GameState, history: RuntimeRecord[]): RuleProgress | null {
  // A line not yet crossed: the same bar, distance and pace as a condition.
  if (behavior.trigger.kind === "crossing" && behavior.trigger.watch) {
    const { variableId, threshold } = behavior.trigger.watch;
    const current = readNumber(state, variableId);
    if (current !== null) {
      const remaining = threshold - current;
      const step = pace(history, variableId);
      const eta = step && Math.sign(step) === Math.sign(remaining) ? Math.ceil(remaining / step) : null;
      return { variableId, current, target: threshold, remaining, eta };
    }
  }
  for (const c of behavior.conditions) {
    if (c.valueRef || typeof c.value !== "number" || !["gt", "gte", "lt", "lte"].includes(c.operator)) continue;
    if (evaluateCondition(state, c)) continue;
    const current = readNumber(state, c.variableId);
    if (current === null) continue;
    const target = c.operator === "gt" ? c.value + (Number.isInteger(c.value) ? 1 : 0) : c.operator === "lt" ? c.value - (Number.isInteger(c.value) ? 1 : 0) : c.value;
    const remaining = target - current;
    const step = pace(history, c.variableId);
    const eta = step && Math.sign(step) === Math.sign(remaining) ? Math.ceil(remaining / step) : null;
    return { variableId: c.variableId, current, target, remaining, eta };
  }
  return null;
}

function statusOf(behavior: Behavior, record: RuntimeRecord, world: WorldDefinition, state: GameState): RuleStatus {
  if (record.firedIds?.includes(behavior.id)) return { kind: "fired" };
  if (!behavior.enabled || state.ruleState?.disabledRules?.includes(behavior.id)) return { kind: "disabled" };
  if (!isMemberActive(behavior.worldbookId, world.worldbooks, state)) return { kind: "inactive" };
  if (!checkConditions(state, behavior.conditions, behavior.conditionLogic)) return { kind: "unmet" };
  if (behavior.stopConditions?.some((c) => evaluateCondition(state, c))) return { kind: "stopped" };
  const until = state.ruleState?.cooldowns?.[behavior.id];
  if (until !== undefined && until > (state.turnCount ?? 0)) return { kind: "cooldown", turnsLeft: until - (state.turnCount ?? 0) };
  const count = state.ruleState?.fireCounts?.[behavior.id] ?? 0;
  if (behavior.maxFireCount !== undefined && count >= behavior.maxFireCount) return { kind: "maxed", count };
  if (behavior.chance !== undefined && behavior.chance < 100 && behavior.trigger.kind === "every-turn") return { kind: "chance", percent: behavior.chance };
  // Still on the near side of its line: not a matter of timing but of how
  // far the number has to go, which the progress bar says.
  if (behavior.trigger.kind === "crossing" && behavior.trigger.watch) {
    const { variableId, threshold, down } = behavior.trigger.watch;
    const current = readNumber(state, variableId);
    if (current !== null && (down ? current > threshold : current < threshold)) return { kind: "unmet" };
  }
  return { kind: "timing", trigger: behavior.trigger };
}

const statusRank: Record<RuleStatus["kind"], number> = {
  fired: 0, chance: 1, cooldown: 2, timing: 3, unmet: 4, stopped: 5, maxed: 6, inactive: 7, disabled: 8,
};

export function explainTurn(world: WorldDefinition, record: RuntimeRecord, history: RuntimeRecord[]): TurnExplanation {
  const changed: ChangedRow[] = record.changes.map((change, index) => {
    const rootId = rootOf(change.variableId);
    return {
      rootId,
      subPath: change.variableId.slice(rootId.length),
      oldValue: change.oldValue,
      newValue: change.newValue,
      delta: typeof change.oldValue === "number" && typeof change.newValue === "number" ? change.newValue - change.oldValue : null,
      source: sourceFor(record, index, rootId),
    };
  });

  const movedRoots = new Set(changed.map((c) => c.rootId));
  const held: HeldRow[] = [];
  if (record.kind !== "restore" && record.kind !== "action") {
    for (const variable of world.variables) {
      if (!watched(variable) || movedRoots.has(variable.id)) continue;
      const reason = heldReason(variable, record.trace);
      if (!reason) continue;
      held.push({ rootId: variable.id, value: record.state?.variables?.[variable.id], reason });
    }
  }

  const rules: RuleRow[] = [];
  const state = record.state;
  if (state && record.kind !== "restore") {
    for (const behavior of behaviors(world, state.turnCount ?? 0)) {
      const status = statusOf(behavior, record, world, state);
      if (status.kind === "disabled") continue;
      rules.push({ id: behavior.id, name: behavior.name, status, progress: status.kind === "unmet" ? progressOf(behavior, state, [...history, record]) : null });
    }
    rules.sort((a, b) => statusRank[a.status.kind] - statusRank[b.status.kind]
      || Math.abs(a.progress?.remaining ?? Infinity) - Math.abs(b.progress?.remaining ?? Infinity));
  }
  return { changed, held, rules };
}

/** The author's own words for when a value should move. */
export function changeHint(variable: Variable | undefined): string {
  return (variable?.behaviorRules || variable?.updateHints || "").trim();
}

/** A one-tag summary for a canvas row: tone plus the `studio.why.*` key. */
export interface ShortWhy { tone: "ai" | "judge" | "rule" | "fix" | "warn" | "plain"; key: string }

export function shortWhyOfSource(source: ChangeSource): ShortWhy | null {
  switch (source.kind) {
    case "ai": return source.repaired ? { tone: "fix", key: "src.repaired" } : { tone: "ai", key: "src.ai" };
    case "judge": return { tone: "judge", key: "src.judge" };
    case "rule": return { tone: "rule", key: "src.rule" };
    case "action": return { tone: "rule", key: "src.action" };
    case "setup": return { tone: "plain", key: "src.setup" };
    case "settle": return { tone: "plain", key: "src.settle" };
    default: return null;
  }
}

export function shortWhyOfHeld(reason: HeldReason): ShortWhy | null {
  switch (reason.kind) {
    case "dropped": return { tone: "warn", key: "tag.blocked" };
    case "rejected": return { tone: "warn", key: "tag.broken" };
    case "judge": return { tone: "judge", key: "src.judge" };
    case "ai-same": return { tone: "plain", key: "tag.same" };
    case "ai-silent": return { tone: "plain", key: "tag.silent" };
    default: return null;
  }
}

/** The newest playtest result, condensed for the canvas rows. */
export function lastTurnWhy(world: WorldDefinition, records: RuntimeRecord[]) {
  const rows = records.filter((r) => r.kind !== "restore");
  const latest = rows[rows.length - 1];
  // Records outlive the playtest; a card that shares no variable with them
  // is not the card they were played on.
  if (!latest?.trace || !world.variables.some((v) => latest.state?.variables && v.id in latest.state.variables)) return null;
  const explained = explainTurn(world, latest, rows.slice(0, -1));
  const vars = new Map<string, ShortWhy>();
  for (const c of explained.changed) {
    const why = shortWhyOfSource(c.source);
    if (why && !vars.has(c.rootId)) vars.set(c.rootId, why);
  }
  for (const h of explained.held) {
    const why = shortWhyOfHeld(h.reason);
    if (why) vars.set(h.rootId, why);
  }
  const rules = new Map<string, string>();
  for (const r of explained.rules) if (r.progress) rules.set(r.id, `${r.progress.current}/${r.progress.target}`);
  return { vars, rules };
}
