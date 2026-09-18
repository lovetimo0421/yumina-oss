import { useCallback, useSyncExternalStore } from "react";

/**
 * React hook — true while the given CSS media query matches. Re-renders on
 * change (resize, rotation), so layout can branch on viewport without a manual
 * resize listener. Stable subscribe/getSnapshot per query (no resubscribe churn).
 *
 * Example: const isMobile = useMediaQuery("(max-width: 639px)");
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (typeof window === "undefined") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => (typeof window !== "undefined" ? window.matchMedia(query).matches : false),
    [query],
  );
  // SSR / pre-hydration: assume desktop (false) to match the wider default layout.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
