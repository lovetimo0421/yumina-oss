/**
 * The one filter shared by the lorebook, variables and behaviours pages.
 *
 *   "all"        everything on the card
 *   "core"       the card's own objects — shared with every module
 *   "bindings"   the lorebook's frontend-controlled view (entries page only)
 *   "mod:<id>"   one module's own objects
 *
 * A module id is prefixed so that a module whose id happens to be "all" or
 * "core" can never be mistaken for the keyword.
 */
export type ModuleScope = string;

export const scopeForModule = (id: string): ModuleScope => `mod:${id}`;

export const moduleIdOfScope = (scope: ModuleScope): string | null =>
  scope.startsWith("mod:") ? scope.slice("mod:".length) : null;

/** Whether an object with this `worldbookId` belongs in the scope. */
export function inModuleScope(scope: ModuleScope, worldbookId: string | undefined): boolean {
  if (scope === "core") return !worldbookId;
  const id = moduleIdOfScope(scope);
  if (id !== null) return worldbookId === id;
  return true;
}

/** The entries page's own dialect: undefined = everything, null = the
 *  card's own, a string = that module. */
export function scopeToEntriesProp(scope: ModuleScope): string | null | undefined {
  if (scope === "core") return null;
  return moduleIdOfScope(scope) ?? undefined;
}

/** A scope that outlived its module, or that means nothing on a card with no
 *  modules, quietly becomes "all" rather than filtering everything away. */
export function normalizeModuleScope(scope: ModuleScope, books: ReadonlyArray<{ id: string }>): ModuleScope {
  const id = moduleIdOfScope(scope);
  if (id !== null) return books.some((b) => b.id === id) ? scope : "all";
  if (scope === "core") return books.length > 0 ? "core" : "all";
  return scope;
}
