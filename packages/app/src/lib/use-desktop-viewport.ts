import { useState } from "react";

/**
 * Wide enough for the blueprint canvas, read once on mount.
 *
 * Deliberately not reactive: this decides which editor a card opens in, and
 * rotating a tablet mid-edit must not yank the editor out from under someone.
 * Anything that needs to follow the viewport should use its own media query.
 */
export function useIsDesktopViewport(): boolean {
  const [desktop] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(min-width: 768px)").matches;
  });
  return desktop;
}
