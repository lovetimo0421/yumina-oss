import { useSyncExternalStore } from "react";

const TOUCH_QUERY = "(pointer: coarse)";

/** Non-hook helper — returns true when the primary pointer is coarse (finger/stylus). */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(TOUCH_QUERY).matches;
}

// Singleton matchMedia instance + subscriber set
let mql: MediaQueryList | null = null;
const listeners = new Set<() => void>();

function getMql() {
  if (!mql && typeof window !== "undefined") {
    mql = window.matchMedia(TOUCH_QUERY);
    mql.addEventListener("change", () => {
      for (const fn of listeners) fn();
    });
  }
  return mql;
}

function subscribe(callback: () => void) {
  getMql(); // ensure listener is attached
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot() {
  return getMql()?.matches ?? false;
}

function getServerSnapshot() {
  return false;
}

/**
 * React hook — re-renders when the pointer type changes
 * (e.g. detaching keyboard on a Surface, connecting a mouse to a tablet).
 */
export function useTouchDevice(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Returns true on iOS / iPadOS.
 * Needed because iOS Safari does not support requestFullscreen() on non-video elements.
 * Uses UA + maxTouchPoints to catch iPadOS (which spoofs a desktop UA).
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}
