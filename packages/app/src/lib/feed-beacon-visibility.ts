import { useEffect, useRef } from "react";

const MAX_DWELL_MS = 30 * 60_000;
interface Visit { identity: string; resume(): void; suspend(): void; finish(): void; closeTimer?: ReturnType<typeof setTimeout> }

/** One close-level foreground interval, including React StrictMode effect replay. */
export function useFeedPreviewDwell(identity: string, onOpen: () => void, onClose: (durationMs: number) => void) {
  const visitRef = useRef<Visit | null>(null);
  useEffect(() => {
    if (visitRef.current?.identity !== identity) {
      visitRef.current?.finish();
      let total = 0;
      let startedAt: number | null = null;
      let finished = false;
      const accrue = () => {
        if (startedAt !== null) total = Math.min(MAX_DWELL_MS, total + Math.max(0, performance.now() - startedAt));
        startedAt = null;
      };
      const visibility = () => {
        accrue();
        if (document.visibilityState === "visible") startedAt = performance.now();
      };
      const visit: Visit = {
        identity,
        resume() {
          clearTimeout(visit.closeTimer);
          visibility();
          document.addEventListener("visibilitychange", visibility);
        },
        suspend() { accrue(); document.removeEventListener("visibilitychange", visibility); },
        finish() {
          if (finished) return;
          finished = true;
          clearTimeout(visit.closeTimer);
          visit.suspend();
          onClose(Math.round(total));
        },
      };
      visitRef.current = visit;
      onOpen();
    }
    const visit = visitRef.current;
    visit.resume();
    return () => {
      visit.suspend();
      // A synchronous re-setup cancels this; a real unmount records one close.
      visit.closeTimer = setTimeout(visit.finish, 0);
    };
    // Callbacks are the immutable snapshot from the start of this opportunity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);
}
