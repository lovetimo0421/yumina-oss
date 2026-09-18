/**
 * Feed training-log beacon (recsys Ship 1).
 *
 * Mirrors the hub_* PostHog events into OUR database (POST
 * /api/feed/events → feed_events) so impressions/clicks/plays finally
 * join against worlds/users server-side — the training data for
 * engagement-aware ranking. PostHog keeps its copy for dashboards; this
 * copy is the one models learn from.
 *
 * Batched: events queue and flush every few seconds, on batch-size, and
 * on page hide (fetch keepalive survives navigation). Fire-and-forget —
 * a lost batch costs training rows, never UX. Never throws.
 */

// `?.` because `tsx --test` has no import.meta.env: this module is now pulled in
// transitively by lib/feedback → lib/analytics, so any store under test that
// shows a pill would otherwise throw at import time.
const apiBase = import.meta.env?.VITE_API_URL || "";

export interface FeedBeaconEvent {
  feedRequestId: string | null;
  worldId: string;
  eventType: "impression" | "click" | "play";
  position: number | null;
  surface: string | null;
}

const FLUSH_INTERVAL_MS = 4000;
const MAX_BATCH = 40;

let queue: FeedBeaconEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const events = queue;
  queue = [];
  try {
    // keepalive lets the request outlive a navigation/tab-hide — same
    // guarantee as sendBeacon but with credentials + JSON semantics that
    // match the rest of the API layer.
    void fetch(`${apiBase}/api/feed/events`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    }).catch(() => {});
  } catch {
    // Never let telemetry break the app.
  }
}

function installListeners(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  // pagehide covers tab close + bfcache navigation; visibilitychange
  // covers mobile app-switching (the 85%-mobile audience rarely "closes"
  // tabs — they background them).
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

export function queueFeedEvent(event: FeedBeaconEvent): void {
  try {
    if (typeof window === "undefined") return;
    installListeners();
    queue.push(event);
    if (queue.length >= MAX_BATCH) {
      flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    }
  } catch {
    // Never let telemetry break the app.
  }
}
