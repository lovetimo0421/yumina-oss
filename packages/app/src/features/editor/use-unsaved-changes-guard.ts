import { useBlocker } from "@tanstack/react-router";

/**
 * Blocks SPA navigation and browser close/refresh when the editor has unsaved changes.
 * Returns the blocker object so callers can render a confirmation dialog.
 */
export function useUnsavedChangesGuard(isDirty: boolean) {
  return useBlocker({
    shouldBlockFn: () => isDirty,
    enableBeforeUnload: () => isDirty,
    disabled: !isDirty,
    withResolver: true,
  });
}
