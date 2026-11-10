import type { GameState } from "@yumina/engine";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Server snapshots replace the previous state: merging would resurrect gates
 * that a rewind or opening switch intentionally removed. Ignore late responses
 * for a different session, and never mistake a variables-only object for state. */
export function withRuntimeState<S extends { id: string; state: Record<string, unknown> }>(
  session: S | null,
  sessionId: string,
  snapshot: unknown,
): S | null {
  if (!session || session.id !== sessionId || !record(snapshot) || !record(snapshot.variables)) return session;
  return { ...session, state: snapshot };
}

/** Read the complete active session state, including zero-variable cards.
 * Optimistic frontend variable edits overlay the latest authoritative gates. */
export function liveRuntimeState(
  session: { id: string; worldId: string; world?: { id: string } | null; state: Record<string, unknown> } | null,
  worldIds: Array<string | null | undefined>,
  variables: GameState["variables"],
): GameState | null {
  if (!session || !worldIds.some((id) => id && (id === session.worldId || id === session.world?.id))) return null;
  const snapshot = session.state;
  if (!record(snapshot) || !record(snapshot.variables)) return null;
  return {
    ...snapshot,
    worldId: typeof snapshot.worldId === "string" ? snapshot.worldId : session.worldId,
    variables,
    turnCount: typeof snapshot.turnCount === "number" ? snapshot.turnCount : 0,
    metadata: record(snapshot.metadata) ? snapshot.metadata : {},
  } as GameState;
}
