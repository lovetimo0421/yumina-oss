/** Validation evidence belongs to the session owner, not public replays. */
export function publicSwipes<T extends { stateValidation?: unknown; generationState?: unknown; variableAudit?: unknown }>(swipes: T[] | null): Omit<T, "stateValidation" | "generationState" | "variableAudit">[] {
  return (swipes ?? []).map(({ stateValidation: _audit, generationState: _baseline, variableAudit: _variables, ...swipe }) => swipe);
}
