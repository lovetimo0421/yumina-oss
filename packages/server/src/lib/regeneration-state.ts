import { deepEqual, preserveSetupScopedVariables } from "@yumina/engine";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { normalizeGameState } from "./game-state.js";

/** Include only concurrent writes the turn did not supersede. In particular,
 * an overlapping UI write must not become the next reroll's starting value
 * when the generated reply won that write under the normal turn policy. */
export function generationBaseline(world: WorldDefinition, liveState: unknown, request: GameState, baseline: GameState, final: GameState): GameState {
  const live = normalizeGameState(world, liveState);
  const result = structuredClone(baseline);
  for (const key of Object.keys(live.variables)) {
    if (!deepEqual(live.variables[key], request.variables[key]) && deepEqual(final.variables[key], request.variables[key])) {
      result.variables[key] = live.variables[key]!;
    }
  }
  for (const key of new Set([...Object.keys(live.metadata), ...Object.keys(request.metadata)])) {
    if (!deepEqual(live.metadata[key], request.metadata[key]) && deepEqual(final.metadata[key], request.metadata[key])) {
      if (key in live.metadata) result.metadata[key] = live.metadata[key];
      else delete result.metadata[key];
    }
  }
  return result;
}

/** Rewind only the replaced reply's writes, preserving subsequent UI edits.
 * New swipes carry the prompt-time baseline. Older swipes recover variable
 * values from their change ledger; the preceding snapshot restores rule state.
 */
export function regenerationState(
  world: WorldDefinition,
  current: GameState,
  reply: { generationState?: Record<string, unknown>; stateSnapshot?: Record<string, unknown> | null; stateChanges?: unknown },
  previous?: Record<string, unknown> | null,
): GameState {
  const after = normalizeGameState(world, reply.stateSnapshot ?? current);
  const before = reply.generationState
    ? normalizeGameState(world, reply.generationState)
    : structuredClone(after);
  if (!reply.generationState) {
    // Reverse in order: a variable may have changed several times in one turn.
    if (Array.isArray(reply.stateChanges)) {
      for (const change of [...reply.stateChanges].reverse()) {
        if (change && typeof change.variableId === "string" && change.oldValue !== undefined) {
          before.variables[change.variableId] = structuredClone(change.oldValue);
        }
      }
    }
    if (previous) {
      const prior = normalizeGameState(world, previous);
      before.ruleState = prior.ruleState;
      for (const key of ["activeAudio", "pendingContext"]) {
        if (key in prior.metadata) before.metadata[key] = prior.metadata[key];
        else delete before.metadata[key];
      }
    }
    if (world.systems?.includes("kochuu-survival-v1")) {
      const prior = previous ? normalizeGameState(world, previous) : null;
      for (const key of ["poison", "poisonTimeTurn"]) {
        if (prior && key in prior.metadata) before.metadata[key] = prior.metadata[key];
        else delete before.metadata[key];
      }
    }
  }
  const result = structuredClone(current);
  for (const key of Object.keys(before.variables)) {
    if (deepEqual(current.variables[key], after.variables[key])) {
      result.variables[key] = before.variables[key]!;
    }
  }
  for (const key of new Set([...Object.keys(before.metadata), ...Object.keys(after.metadata)])) {
    if (deepEqual(current.metadata[key], after.metadata[key])) {
      if (key in before.metadata) result.metadata[key] = before.metadata[key];
      else delete result.metadata[key];
    }
  }
  if (deepEqual(current.ruleState, after.ruleState)) result.ruleState = before.ruleState;
  // Regeneration replaces a reply within this turn, never advances/rewinds it.
  return preserveSetupScopedVariables(world.variables, { ...current }, { ...result });
}
