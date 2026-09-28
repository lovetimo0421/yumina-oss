import { deepEqual } from "@yumina/engine";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { normalizeGameState, reconcileTurnState } from "./game-state.js";

/** A reply's starting state is immutable, even if UI writes arrive while it
 * streams. Its alternatives must all describe outcomes of that same state. */
export function generationBaseline(_world: WorldDefinition, _liveState: unknown, _request: GameState, baseline: GameState, _final: GameState): GameState {
  return structuredClone(baseline);
}

/** The first recoverable baseline belongs to the message, not its selected
 * alternative. This also stops older, already-drifted swipes spreading drift. */
export function messageGenerationState(swipes: ReadonlyArray<{ generationState?: Record<string, unknown> }> | null | undefined): Record<string, unknown> | undefined {
  return swipes?.find(swipe => swipe.generationState)?.generationState;
}

/** Restore the entire pre-reply variable snapshot, including nested JSON.
 * Historical replies rewind their stored outcome through the change ledger. */
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
  result.variables = structuredClone(before.variables);
  for (const key of new Set([...Object.keys(before.metadata), ...Object.keys(after.metadata)])) {
    if (deepEqual(current.metadata[key], after.metadata[key])) {
      if (key in before.metadata) result.metadata[key] = before.metadata[key];
      else delete result.metadata[key];
    }
  }
  result.ruleState = structuredClone(before.ruleState);
  // Regeneration replaces a reply within this turn, never advances/rewinds it.
  return result;
}

/** Ordinary sends preserve concurrent UI writes. A replacement reply instead
 * owns its complete variable outcome, even when a value equals the old reply.
 * Otherwise a concurrent patch can leak into a supposedly independent swipe. */
export function reconcileRegenerationState(world: WorldDefinition, live: unknown, request: GameState, final: GameState): GameState {
  return { ...reconcileTurnState(world, live, request, final), variables: structuredClone(final.variables) };
}
