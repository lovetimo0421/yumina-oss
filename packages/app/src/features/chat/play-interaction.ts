// Browser evidence only: no click targets, text, keys, or coordinates are stored.
// A short-lived per-session signal also works for opaque-origin UGC iframes.
const inputs = new Map<string, number>();
export function notePlayInteraction(sessionId: string) {
  const now = performance.now();
  for (const [id, at] of inputs) if (now - at > 120_000) inputs.delete(id);
  if (sessionId) inputs.set(sessionId, now);
}
export function hasRecentPlayInteraction(sessionId: string) {
  const at = inputs.get(sessionId);
  return document.visibilityState === "visible" && at !== undefined && performance.now() - at <= 120_000;
}
