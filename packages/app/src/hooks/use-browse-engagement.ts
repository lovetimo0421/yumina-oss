import { useEffect } from "react";

export function browseSurface(path: string): "browse" | "community" | null {
  if (/^\/app\/community(?:\/|$)/.test(path)) return "community";
  if (/^\/app\/(hub|library|preview)(?:\/|$)/.test(path)) return "browse";
  return null;
}

/** Passive input observation; scrolling never causes a render or network call. */
export function useBrowseEngagement(userId: string | null, path: string) {
  const surface = browseSurface(path);
  useEffect(() => {
    if (!userId || !surface) return;
    const lease = crypto.randomUUID();
    let sequence = 0, evidence = 0, lastInput = -Infinity, lastEvidence = -Infinity, inflight = false, wasActive = false;
    const input = (event: Event) => {
      if (!event.isTrusted || document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (event instanceof KeyboardEvent && !["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ", "Tab"].includes(event.key)) return;
      const now = performance.now(); lastInput = now;
      // A second separated input is required. One click followed by a parked tab is insufficient.
      if (now - lastEvidence >= 5000) { evidence++; lastEvidence = now; }
    };
    const send = (stop = false) => {
      if (inflight && !stop) return;
      const active = !stop && document.visibilityState === "visible" && document.hasFocus() && performance.now() - lastInput < 90000;
      if (!active && !wasActive) return;
      wasActive = active;
      inflight = true;
      void fetch(`${import.meta.env?.VITE_API_URL || ""}/api/engagement/browse`, {
        method: "POST", credentials: "include", keepalive: stop,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lease, sequence: ++sequence, surface, active, evidence }),
      }).catch(() => {}).finally(() => { inflight = false; });
    };
    const pause = () => { lastInput = -Infinity; send(true); };
    const visibility = () => { if (document.visibilityState !== "visible") pause(); };
    for (const name of ["wheel", "touchmove", "pointerdown", "keydown"]) window.addEventListener(name, input, { passive: true, capture: true });
    window.addEventListener("blur", pause);
    window.addEventListener("pagehide", pause);
    document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(() => send(), 15000);
    return () => {
      clearInterval(timer); pause();
      for (const name of ["wheel", "touchmove", "pointerdown", "keydown"]) window.removeEventListener(name, input, true);
      window.removeEventListener("blur", pause); window.removeEventListener("pagehide", pause);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [userId, surface]);
}
