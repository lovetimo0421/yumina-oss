import type { GameEvent, Reaction } from "../events/types.js";
import type { Rule, AudioEffect } from "../types/index.js";
import type { GameStateManager } from "../state/game-state-manager.js";
import { ReactionEvaluator } from "./reaction-evaluator.js";
import { processSystemEffects, applySystemEffects } from "../systems/effect-processor.js";

/** Aggregated outcome of running a reaction chain to completion. */
export interface ReactionRunResult {
  /** All game-variable changes applied across every hop, in order. */
  changes: Array<{ variableId: string; oldValue: unknown; newValue: unknown }>;
  /** Audio effects emitted by fired reactions. */
  audioEffects: AudioEffect[];
  /** Player notifications emitted by fired reactions. */
  notifications: Array<{ message: string; style: string }>;
  /** One-shot context messages for the next AI turn. */
  contextMessages: Array<{ message: string; role: string }>;
  /** IDs of every reaction that fired across the chain. */
  firedIds: string[];
}

const DEFAULT_MAX_DEPTH = 5;

/**
 * Evaluate reactions against `initialEvents` and follow the chain: effects that
 * emit events, and variable changes that produce `state:changed` events, are fed
 * back into the evaluator until the chain settles.
 *
 * Safety model — a reaction fires at most ONCE per chain: after it fires it is
 * removed from the active set, so effects are never double-applied and a
 * reaction that re-triggers itself cannot loop. `maxDepth` is a hard backstop.
 *
 * Fires are recorded on the state manager (`recordRuleFired`), which is what
 * makes `cooldownTurns` / `maxFireCount` take effect on subsequent turns.
 *
 * Mutates `stateManager`. Returns the aggregated outcome for the caller to
 * persist / stream.
 */
export function runReactionChain(
  evaluator: ReactionEvaluator,
  stateManager: GameStateManager,
  initialEvents: GameEvent[],
  reactions: Reaction[],
  rules: Rule[],
  options?: { maxDepth?: number },
): ReactionRunResult {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;

  const cooldownById = new Map<string, number | undefined>();
  for (const r of rules) cooldownById.set(r.id, r.cooldownTurns);
  for (const r of reactions) cooldownById.set(r.id, r.cooldownTurns);

  const out: ReactionRunResult = {
    changes: [],
    audioEffects: [],
    notifications: [],
    contextMessages: [],
    firedIds: [],
  };

  let activeReactions = reactions;
  let activeRules = rules;
  let events = initialEvents;
  let depth = 0;

  while (events.length > 0 && depth < maxDepth && (activeReactions.length > 0 || activeRules.length > 0)) {
    const result = evaluator.evaluateMultiple(events, activeReactions, activeRules, stateManager.getSnapshot(), { oncePerReaction: true });
    if (result.firedIds.length === 0) break;

    const systemResult = processSystemEffects(result.effects);
    const changes = applySystemEffects(stateManager, systemResult);

    // Keep bookkeeping unique as well as execution (including legacy rules).
    const firedThisHop = new Set(result.firedIds);
    const turnCount = stateManager.getSnapshot().turnCount;
    for (const id of firedThisHop) {
      stateManager.recordRuleFired(id, turnCount, cooldownById.get(id));
    }

    out.changes.push(...changes);
    out.audioEffects.push(...systemResult.audioEffects);
    out.notifications.push(...systemResult.notifications);
    out.contextMessages.push(...systemResult.contextMessages);
    out.firedIds.push(...firedThisHop);

    // Retire fired reactions so they can't fire again in this chain.
    activeReactions = activeReactions.filter((r) => !firedThisHop.has(r.id));
    activeRules = activeRules.filter((r) => !firedThisHop.has(r.id));

    // Next hop: explicitly emitted events + state:changed from this hop's variable changes.
    events = [
      ...result.emittedEvents,
      ...changes.map((c) => ({
        type: "state:changed" as const,
        variableId: c.variableId,
        oldValue: c.oldValue,
        newValue: c.newValue,
      })),
    ];
    depth++;
  }

  const settledChanges = stateManager.settleSystems();
  out.changes.push(...settledChanges);
  if (settledChanges.length && depth < maxDepth) {
    // Derived deaths still emit events (e.g. the card's death sound). Fired
    // rules stay retired when settlement re-enters the bounded chain.
    const settled = runReactionChain(evaluator, stateManager,
      settledChanges.map(change => ({ type: "state:changed" as const, ...change })),
      activeReactions, activeRules, { maxDepth: maxDepth - depth - 1 });
    out.changes.push(...settled.changes);
    out.audioEffects.push(...settled.audioEffects);
    out.notifications.push(...settled.notifications);
    out.contextMessages.push(...settled.contextMessages);
    out.firedIds.push(...settled.firedIds);
  }
  return out;
}
