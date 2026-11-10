import {
  GameStateManager,
  ReactionEvaluator,
  buildActionFiredEvent,
  buildMessageAIEvent,
  buildMessageUserEvent,
  buildSessionStartEvent,
  buildTurnCompleteEvent,
  runReactionChain,
  type GameEvent,
  type WorldDefinition,
} from "@yumina/engine";
import type { Effect } from "@yumina/engine";

/**
 * A free check of a card's behaviors: the engine alone, no model call.
 *
 * After changing variables or behaviors, the assistant used to either claim it
 * works or pay for a real playtest (the card's own model, billed to the
 * creator). Only 1.6% of logic-writing runs played the card at all. This runs
 * the same reaction chain the server runs on a player's action or turn, from
 * the card's defaults plus any starting values, and reports what fired and
 * what changed. It cannot judge anything the AI writes — prose, or variables
 * the AI or the repair model would set — and says so.
 */

export const SIMULATE_MAX_STEPS = 10;

export type SimulateStep =
  | { action: string; params?: Record<string, unknown> }
  | { turn: true; player?: string; reply?: string; ai_sets?: Record<string, unknown> }
  | { set: Record<string, unknown> }
  | { clock: number };

export interface SimulateResult {
  steps: Array<{
    step: number;
    event: string;
    fired: Array<{ id: string; name: string }>;
    changes: Array<{ variable: string; from: unknown; to: unknown; by: string[] }>;
    notifications?: string[];
    aiContext?: string[];
    sounds?: number;
    note?: string;
  }>;
  /** End values of every variable the steps touched. */
  final: Record<string, unknown>;
  warnings: string[];
  limits: string;
  error?: string;
}

const LIMITS = "Engine only: behaviors, conditions and effects run exactly as in play, but no model was called. "
  + "What the AI writes, and variables the AI or the repair model would set, are not tested; pass them as ai_sets on a turn step to see what behaviors do with them. "
  + "Random effects draw once per run.";

/** `{ "hp": 3, "bag.coins": 10 }` → set effects; dot-paths address json variables. */
function setEffects(values: Record<string, unknown>, known: Set<string>, warnings: string[]): Effect[] {
  const effects: Effect[] = [];
  for (const [key, value] of Object.entries(values)) {
    const root = key.split(/[.[]/)[0]!;
    if (!known.has(root)) { warnings.push(`No variable "${root}" — "${key}" was ignored.`); continue; }
    // The state manager reads a dotted variableId as a path into the root.
    effects.push({ variableId: key, operation: "set", value: value as Effect["value"] });
  }
  return effects;
}

function rootsOf(values: Record<string, unknown> | undefined): Set<string> {
  return new Set(Object.keys(values ?? {}).map((key) => key.split(/[.[]/)[0]!));
}

export function executeSimulateBehaviors(world: WorldDefinition, args: { start?: unknown; steps?: unknown }): SimulateResult {
  const result: SimulateResult = { steps: [], final: {}, warnings: [], limits: LIMITS };
  const steps = Array.isArray(args.steps) ? args.steps.slice(0, SIMULATE_MAX_STEPS) as SimulateStep[] : [];
  if (steps.length === 0) return { ...result, error: "Give 1-10 steps, e.g. [{ \"action\": \"rest\" }, { \"turn\": true }]." };
  if (Array.isArray(args.steps) && args.steps.length > SIMULATE_MAX_STEPS) result.warnings.push(`Only the first ${SIMULATE_MAX_STEPS} steps ran.`);

  const reactions = world.reactions ?? [];
  const rules = world.rules ?? [];
  const known = new Set(world.variables.map((v) => v.id));
  const names = new Map<string, string>([...reactions, ...rules].map((r) => [r.id, r.name ?? r.id]));
  const listenedActions = new Set(reactions
    .filter((r) => r.when?.eventType === "action:fired")
    .map((r) => (r.when.match?.actionId as { value?: unknown } | undefined)?.value)
    .filter((v): v is string => typeof v === "string"));
  if (reactions.some((r) => JSON.stringify(r.then ?? []).includes("\"valueRandom\"") || (r.chance ?? 100) < 100)) {
    result.warnings.push("Some behaviors are random (chance or random values): another run can come out differently.");
  }

  const manager = new GameStateManager(world);
  const evaluator = new ReactionEvaluator();
  const touched = new Set<string>();
  if (args.start && typeof args.start === "object" && !Array.isArray(args.start)) {
    for (const c of manager.applyEffects(setEffects(args.start as Record<string, unknown>, known, result.warnings))) touched.add(c.variableId);
  }

  steps.forEach((step, index) => {
    const out: SimulateResult["steps"][number] = { step: index + 1, event: "", fired: [], changes: [] };
    let events: GameEvent[] = [];
    if (step && typeof step === "object" && "action" in step && typeof step.action === "string") {
      out.event = `action ${step.action}`;
      events = [{ ...buildActionFiredEvent(step.action), ...(step.params ? { params: step.params } : {}) } as GameEvent];
      if (!listenedActions.has(step.action)) out.note = `No behavior listens for action "${step.action}"${listenedActions.size ? ` (listened: ${[...listenedActions].slice(0, 12).join(", ")})` : ""}.`;
    } else if (step && typeof step === "object" && "turn" in step) {
      manager.incrementTurn();
      const turnCount = manager.getSnapshot().turnCount;
      out.event = `turn ${turnCount}`;
      const aiChanges = step.ai_sets ? manager.applyEffects(setEffects(step.ai_sets, known, result.warnings)) : [];
      const given = rootsOf(step.ai_sets);
      for (const c of aiChanges) {
        out.changes.push({ variable: c.variableId, from: c.oldValue, to: c.newValue, by: [given.has(c.variableId) ? "AI (given)" : "formula"] });
        touched.add(c.variableId);
      }
      events = [
        buildMessageUserEvent(step.player ?? ""),
        buildMessageAIEvent(step.reply ?? ""),
        buildTurnCompleteEvent(turnCount),
        ...(turnCount === 1 ? [buildSessionStartEvent()] : []),
        ...aiChanges.map((c) => ({ type: "state:changed" as const, variableId: c.variableId, oldValue: c.oldValue, newValue: c.newValue })),
      ];
    } else if (step && typeof step === "object" && "set" in step && step.set && typeof step.set === "object") {
      const changes = manager.applyEffects(setEffects(step.set, known, result.warnings));
      out.event = `set ${Object.keys(step.set).join(", ")}`;
      const given = rootsOf(step.set);
      for (const c of changes) {
        out.changes.push({ variable: c.variableId, from: c.oldValue, to: c.newValue, by: [given.has(c.variableId) ? "set (given)" : "formula"] });
        touched.add(c.variableId);
      }
      events = changes.map((c) => ({ type: "state:changed" as const, variableId: c.variableId, oldValue: c.oldValue, newValue: c.newValue }));
    } else if (step && typeof step === "object" && "clock" in step && typeof step.clock === "number") {
      out.event = `clock every ${step.clock}s`;
      events = [{ type: "clock:every", seconds: step.clock } as GameEvent];
    } else {
      out.event = "unreadable step";
      out.note = "Each step needs one of: action, turn, set, clock.";
      result.steps.push(out);
      return;
    }

    const run = runReactionChain(evaluator, manager, events, reactions, rules, { worldbooks: world.worldbooks });
    out.fired = [...new Set(run.firedIds)].map((id) => ({ id, name: names.get(id) ?? id }));
    run.changes.forEach((c, i) => {
      out.changes.push({ variable: c.variableId, from: c.oldValue, to: c.newValue,
        by: (run.changeCauses[i] ?? []).map((id) => names.get(id) ?? id) });
      touched.add(c.variableId);
    });
    if (run.notifications.length) out.notifications = run.notifications.map((n) => n.title ? `${n.title}: ${n.message}` : n.message);
    if (run.contextMessages.length) out.aiContext = run.contextMessages.map((m) => m.message);
    if (run.audioEffects.length) out.sounds = run.audioEffects.length;
    if (out.fired.length === 0 && !out.note) {
      out.note = out.notifications?.length ? "Nothing fired: a behavior's conditions were not met (its message is in notifications)." : "Nothing fired.";
    }
    result.steps.push(out);
  });

  const snapshot = manager.getSnapshot();
  for (const id of touched) result.final[id] = snapshot.variables[id];
  return result;
}
