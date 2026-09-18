/**
 * Session-state PATCH queue.
 *
 * A custom UI commits variables in bursts — 问道's character-creation screen
 * writes ~60 in one tick and immediately sends its opening message. One
 * fire-and-forget PATCH per write meant ~60 parallel requests, each carrying
 * the FULL variables map: they land out of order, so whichever arrives last
 * decides the stored state, and the message POST races past all of them and
 * reads a half-written session (2026-09-01 session 1dadfb55 kept writes 1..24).
 *
 * So: coalesce a burst into ONE request, keep at most one in flight, and let
 * the sender wait for the queue to drain before it POSTs the turn.
 */

export interface SessionStatePatch {
  sessionId: string;
  state: unknown;
}

/** Injected so tests can drive the queue without a network. */
export type SessionStatePatchSender = (patch: SessionStatePatch) => Promise<unknown>;

let chain: Promise<void> = Promise.resolve();
let scheduled = false;

/**
 * Queue a flush. `readPatch` runs at flush time, not call time, so a burst of
 * writes ships one request carrying the latest values. Returning null skips
 * the request (session gone).
 */
export function queueSessionStatePatch(
  readPatch: () => SessionStatePatch | null,
  send: SessionStatePatchSender,
): void {
  if (scheduled) return; // the pending flush will pick this write up too
  scheduled = true;
  // Never let a link reject: whenSessionStateSettled() awaits this chain before
  // a send, and a poisoned chain would leave the turn stuck at "streaming".
  chain = chain.then(
    () =>
      new Promise<void>((resolve) => {
        queueMicrotask(() => {
          scheduled = false;
          let patch: SessionStatePatch | null = null;
          try {
            patch = readPatch();
          } catch {
            patch = null;
          }
          if (!patch) {
            resolve();
            return;
          }
          void Promise.resolve()
            .then(() => send(patch as SessionStatePatch))
            .then(
              () => resolve(),
              () => resolve(),
            );
        });
      }),
  );
}

/**
 * An acknowledged operation (for example fresh-state PATCH + checkpoint POST)
 * occupies the same queue as ordinary variable writes. Later patches cannot
 * overtake either half of the operation. Its deadline includes time queued.
 *
 * The callback must pass the signal to network requests and check it before
 * starting each subsequent side effect. A deadline rejects the caller promptly,
 * but does not release the queue while an already-running callback is unwinding;
 * otherwise an abort-insensitive request could still race a later state patch.
 */
export function queueSessionStateOperation<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Session save timed out. Please try again.");
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const operation = chain.then(async () => {
    // An expired operation must never start later when the earlier PATCH clears.
    if (controller.signal.aborted)
      throw controller.signal.reason || new Error("Session save cancelled.");
    return run(controller.signal);
  });
  // A failed/expired save cannot poison subsequent variable writes.
  chain = operation.then(() => {}, () => {});
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolves once every queued session-state PATCH has been answered — or after
 * `timeoutMs`, whichever comes first. The deadline is not optional: a request
 * that never settles (dead mobile radio, no fetch timeout) would otherwise
 * block the player's next message forever. Giving up early only costs prompt
 * freshness for one turn; the server reconciles the late patch either way.
 */
export async function whenSessionStateSettled(timeoutMs = 4000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve();
    }, timeoutMs);
  });
  try {
    // Each awaited link can append another (a write issued while one is in
    // flight), so keep draining until the chain stops growing. Bounded so a
    // pathological writer can never wedge a send.
    for (let i = 0; i < 100; i++) {
      const current = chain;
      await Promise.race([current.catch(() => {}), deadline]);
      if (expired) return;
      if (current === chain && !scheduled) return;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test seam — drops any queued work and resets the chain. */
export function __resetSessionStateQueue(): void {
  chain = Promise.resolve();
  scheduled = false;
}
