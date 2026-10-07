import { useBlocker } from "@tanstack/react-router";

/**
 * Blocks SPA navigation and browser close/refresh when the editor has unsaved changes.
 * Returns the blocker object so callers can render a confirmation dialog.
 */
export function useUnsavedChangesGuard(isDirty: boolean, options?: {
  /** A completed save can precede React's next render; read the store at navigation time. */
  getIsDirty?: () => boolean;
  beforeLeave?: () => void;
}) {
  const hasChanges = () => options?.getIsDirty?.() ?? isDirty;
  const check = () => {
    const dirty = hasChanges();
    if (dirty) options?.beforeLeave?.();
    return dirty;
  };
  return useBlocker({
    shouldBlockFn: check,
    enableBeforeUnload: check,
    disabled: options?.getIsDirty ? false : !isDirty,
    withResolver: true,
  });
}
