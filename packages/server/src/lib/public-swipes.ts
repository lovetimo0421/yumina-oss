/** Validation evidence belongs to the session owner, not public replays. */
export function publicSwipes<T extends { stateValidation?: unknown; generationState?: unknown }>(swipes: T[] | null): Omit<T, "stateValidation" | "generationState">[] {
  return (swipes ?? []).map(({ stateValidation: _audit, generationState: _baseline, ...swipe }) => swipe);
}
