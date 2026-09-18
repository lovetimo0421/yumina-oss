/**
 * Read a value out of the variables map by a flat id or a dot-path
 * (e.g. "hp", "inventory.gold", "party.0.hp"). Returns undefined if the path
 * is empty, a segment is missing, or a non-object is traversed.
 *
 * Used to resolve variable references on the right-hand side of conditions
 * (variable-vs-variable) and as effect operands (variable-driven values).
 */
export function getByPath(variables: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  // Flat fast-path: an exact top-level key. Covers plain ids (no dot) and the
  // rare literal key that happens to contain a dot.
  if (Object.prototype.hasOwnProperty.call(variables, path)) return variables[path];

  let current: unknown = variables;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
