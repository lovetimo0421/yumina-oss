/**
 * Decides whether the tab may reload itself to pick up a new build. Pure so the
 * truth table is unit-tested; `lib/deploy-refresh.ts` builds the snapshot from
 * the DOM and stores. Spec §5.
 */
export interface ReloadSnapshot {
  /** A textarea / contenteditable anywhere, or the focused input, has user text. */
  textEntryHasContent: boolean;
  chatStreaming: boolean;
  editorDirty: boolean;
  /** Studio agent working or its chat streaming. */
  studioBusy: boolean;
  dialogOpen: boolean;
  /** Reasons registered through holdReload(): uploads, game rooms. */
  holds: readonly string[];
  /** On an authoring route (editor, Studio, create, bundle edit): never reload, dirty or not. */
  protectedRoute: boolean;
}

/**
 * Authoring and play surfaces are off-limits for self-reloads even when
 * everything looks saved: debounced fields, half-finished agent turns, in-memory
 * undo history, a game's sandbox UI state and scroll position are all things a
 * creator or player would lose without knowing they were at risk. The next route
 * change AWAY from these pages is the safe moment; until then the tab keeps its
 * current build (the 6h fallback pill still offers a manual refresh).
 */
const PROTECTED_PATH =
  /^\/app\/(worlds\/[^/]+\/edit|worlds\/create|studio\/|bundles\/[^/]+\/edit|chat\/|preview\/)/;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATH.test(pathname);
}

export function isSafeToReload(s: ReloadSnapshot): boolean {
  return (
    !s.protectedRoute &&
    !s.textEntryHasContent &&
    !s.chatStreaming &&
    !s.editorDirty &&
    !s.studioBusy &&
    !s.dialogOpen &&
    s.holds.length === 0
  );
}

const holdCounts = new Map<string, number>();

/**
 * Block deploy reloads while something that must not be interrupted is running.
 * Returns a release function; calling it twice is harmless.
 */
export function holdReload(reason: string): () => void {
  holdCounts.set(reason, (holdCounts.get(reason) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (holdCounts.get(reason) ?? 1) - 1;
    if (n <= 0) holdCounts.delete(reason);
    else holdCounts.set(reason, n);
  };
}

export function activeReloadHolds(): string[] {
  return [...holdCounts.keys()];
}

export function __resetReloadHoldsForTests(): void {
  holdCounts.clear();
}
