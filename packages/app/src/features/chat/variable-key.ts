/**
 * Resolve whatever key a card's frontend passes to `api.setVariable()` into the
 * `Variable.id` the session state is actually keyed by.
 *
 * Same forgiveness the engine already gives the LLM (GameStateManager.resolveVariable:
 * id first, display name second). Without it, a card calling
 * `api.setVariable("hunger", 50)` when the id is a UUID writes a phantom `hunger`
 * key that looks fine for one render and is then dropped by normalizeState() on
 * the next turn — a write that silently un-happens.
 *
 * Unknown keys pass through untouched: `__lore_{slotId}` flags and combat-panel's
 * undeclared keys are legitimately not in `world.variables`.
 */
export function makeVariableKeyResolver(
  defs: ReadonlyArray<{ id: string; name?: string }> | undefined,
): (key: string) => string {
  if (!defs?.length) return (key) => key;
  const ids = new Set(defs.map((d) => d.id));
  const byName = new Map<string, string>();
  for (const d of defs) {
    const name = d.name?.trim();
    // A name that already is some variable's id belongs to that variable — never
    // let a display-name collision redirect a write.
    if (!name || name === d.id || ids.has(name)) continue;
    if (!byName.has(name)) byName.set(name, d.id);
  }
  if (byName.size === 0) return (key) => key;
  return (key) => (ids.has(key) ? key : byName.get(key) ?? key);
}
