interface SessionStateSnapshot {
  session: { id: string; state?: unknown } | null;
  gameState: Record<string, unknown>;
  messages?: readonly unknown[];
}

function continuesHistory(before: SessionStateSnapshot, current: SessionStateSnapshot): boolean {
  if (before.messages === current.messages) return true;
  // Stream completion may append a turn. Rewind, restart, checkpoint restore,
  // and swipe replace/remove existing message objects and invalidate the ACK.
  return !!before.messages && !!current.messages && current.messages.length > before.messages.length
    && before.messages.every((message, index) => current.messages![index] === message);
}

function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key =>
    Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function withoutVariables(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  const { variables: _variables, ...rest } = state as Record<string, unknown>;
  return rest;
}

/** Preserve an independent edit even if a stream delivered its older value.
 * Derived transactions (including setup) cannot be safely split and are skipped.
 */
export function reconcileSessionStateConfirmation<T>(
  sessionId: string,
  before: SessionStateSnapshot,
  current: SessionStateSnapshot,
  requested: Record<string, unknown>,
  confirmed: Record<string, unknown> & { variables: Record<string, T> },
): (Record<string, unknown> & { variables: Record<string, T> }) | null {
  if (canApplySessionStateConfirmation(sessionId, before, current)) return confirmed;
  if (before.session?.id !== sessionId || current.session?.id !== sessionId) return null;
  if (current.session.state !== before.session.state || !continuesHistory(before, current)) return null;
  if (!sameJson(withoutVariables(before.session.state), withoutVariables(confirmed))) return null;
  const allKeys = new Set([...Object.keys(before.gameState), ...Object.keys(confirmed.variables)]);
  for (const key of allKeys) {
    if (!Object.hasOwn(requested, key) && !sameJson(before.gameState[key], confirmed.variables[key])) return null;
  }
  const variables = { ...current.gameState } as Record<string, T>;
  let changed = false;
  for (const key of Object.keys(requested)) {
    if (Object.hasOwn(confirmed.variables, key) && sameJson(current.gameState[key], before.gameState[key])) {
      variables[key] = confirmed.variables[key]!;
      changed = true;
    }
  }
  return changed ? { ...withoutVariables(current.session.state), variables } : null;
}

/**
 * A PATCH acknowledgement contains a whole server snapshot. Only adopt it while
 * the immutable state captured when the request started is still current.
 * A later SSE completion, rewind, or local write owns the newer snapshot; merging
 * an old acknowledgement into it could split derived variables from metadata.
 */
export function canApplySessionStateConfirmation(
  sessionId: string,
  before: SessionStateSnapshot,
  current: SessionStateSnapshot,
): boolean {
  return before.session?.id === sessionId
    && current.session?.id === sessionId
    && current.gameState === before.gameState
    && current.session.state === before.session.state
    && continuesHistory(before, current);
}
