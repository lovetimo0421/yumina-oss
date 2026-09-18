import type { Variable } from "../types/index.js";

/** Minimal shape shared by GameState and the server's raw session-state records. */
type StateLike = { variables?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Preserve "setup"-scoped variables when a stored snapshot is applied over the
 * live state.
 *
 * Setup-scoped variables (Variable.scope === "setup") are session-config choices
 * made once at session start — e.g. which characters the player picked at a
 * pre-game cast screen. Two operations REPLACE the live state with a stored
 * snapshot and would otherwise wipe those choices back to their world defaults:
 *
 *   1. Switching the opening — each opening renders as a swipe carrying its OWN
 *      stateSnapshot (world defaults + that opening's initialVariables). Adopting
 *      it clobbers any variable the pre-game UI had already written.
 *   2. Revert / branch — restores an older message's snapshot.
 *
 * This returns `next` with every setup-scoped variable that exists in `current`
 * copied over `next`'s value, so the player's choice carries through. It is a
 * pure function (inputs are never mutated) and a no-op when the world declares no
 * setup-scoped variables, so it is safe to call on every snapshot application.
 */
export function preserveSetupScopedVariables<T extends StateLike>(
  variables: Variable[],
  current: StateLike | null | undefined,
  next: T,
): T {
  const setupIds = variables
    .filter((v) => v.scope === "setup")
    .map((v) => v.id);
  if (setupIds.length === 0) return next;

  const currentVars = current?.variables ?? {};
  const nextVars = (next.variables ?? {}) as Record<string, unknown>;
  const merged = { ...nextVars };
  let changed = false;

  for (const id of setupIds) {
    // Only carry a setup variable forward when the current state actually holds
    // one — never inject `undefined`, which would shadow the snapshot's default.
    if (Object.prototype.hasOwnProperty.call(currentVars, id)) {
      const value = currentVars[id];
      if (!Object.is(merged[id], value)) {
        merged[id] = value;
        changed = true;
      }
    }
  }

  return changed ? { ...next, variables: merged } : next;
}
