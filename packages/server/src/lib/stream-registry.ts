/**
 * Active-stream registry — graceful deploys for in-flight LLM generations.
 *
 *   ┌──────────────┐  registerStream(ac)   ┌──────────────────┐
 *   │ SSE handler  │──────────────────────▶│  activeStreams   │
 *   │ (msg/agent/  │   unregister() in     │  Set<Controller> │
 *   │  dm/side)    │◀──────  finally  ─────│                  │
 *   └──────────────┘                       └────────┬─────────┘
 *                                                   │ SIGTERM
 *                                                   ▼
 *                       drainStreams(50s): poll until empty, then
 *                       abort stragglers with SHUTDOWN_ABORT_REASON
 *
 * Railway gives 60s between SIGTERM and SIGKILL (railway.toml
 * shutdownTimeoutSeconds). We drain up to ~50s so most generations finish
 * naturally, then abort the rest with a DISTINCT reason. Handlers branch on
 * that reason: a client abort (explicit stop endpoint / mid-stream credit
 * exhaustion) skips persistence, while a shutdown abort logs usage and sends
 * the client a clean SERVER_RESTART error instead of a dead connection.
 * A plain SSE disconnect (mobile tab suspend, network drop) does NOT abort:
 * the generation finishes server-side and persists, and the client's
 * connection-loss recovery poll picks the reply up (2026-08-06 content-loss
 * fix).
 *
 * NOTE: there is deliberately NO inactivity watchdog here — the providers
 * already enforce stream-inactivity timeouts (lib/llm/constants.ts, 600s for
 * thinking models / 90s short). A route-level timer would cut off reasoning
 * models that legitimately pause output while thinking.
 */

export const SHUTDOWN_ABORT_REASON = "server-shutdown";
export const USER_STOP_ABORT_REASON = "user-stop";

const activeStreams = new Set<AbortController>();

// Session-keyed view of the same controllers. Client disconnects no longer
// abort generation (the turn finishes and persists so suspended mobile tabs
// stop losing replies) — so an EXPLICIT stop needs a server-side path: the
// stop endpoint looks the stream up by session and aborts it with
// USER_STOP_ABORT_REASON (which handlers treat as a client abort: discard,
// don't charge).
const sessionStreams = new Map<string, AbortController>();

/** Register a generation's AbortController. Returns the deregister fn — call it in the handler's finally. */
export function registerStream(ac: AbortController, sessionId?: string): () => void {
  activeStreams.add(ac);
  if (sessionId) sessionStreams.set(sessionId, ac);
  return () => {
    activeStreams.delete(ac);
    if (sessionId && sessionStreams.get(sessionId) === ac) sessionStreams.delete(sessionId);
  };
}

/** Abort the session's in-flight generation as an explicit user stop. Returns false when nothing was running. */
export function stopSessionStream(sessionId: string): boolean {
  const ac = sessionStreams.get(sessionId);
  if (!ac || ac.signal.aborted) return false;
  try {
    ac.abort(USER_STOP_ABORT_REASON);
  } catch {
    /* an already-aborted controller is fine */
  }
  return true;
}

export function activeStreamCount(): number {
  return activeStreams.size;
}

/** True when the signal was aborted by the shutdown drain (deploy), not by the client. */
export function isShutdownAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === SHUTDOWN_ABORT_REASON;
}

/** True for user-stop / disconnect / mid-stream credit aborts — everything except shutdown. */
export function isClientAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason !== SHUTDOWN_ABORT_REASON;
}

/**
 * Shutdown drain: wait up to maxWaitMs for active generations to finish
 * naturally, then abort stragglers with the shutdown reason.
 */
export async function drainStreams(
  maxWaitMs: number,
): Promise<{ finishedNaturally: boolean; abortedCount: number }> {
  const deadline = Date.now() + maxWaitMs;
  while (activeStreams.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const stragglers = [...activeStreams];
  for (const ac of stragglers) {
    try {
      ac.abort(SHUTDOWN_ABORT_REASON);
    } catch {
      /* an already-aborted controller is fine */
    }
  }
  return { finishedNaturally: stragglers.length === 0, abortedCount: stragglers.length };
}
