// History writes must finish before a new generation takes its snapshot.
// Register synchronously, including while the sandbox's UI state is in transit.
const pending = new Map<string, Set<Promise<unknown>>>();

export function withSessionHistoryMutation<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const operations = pending.get(sessionId) ?? new Set<Promise<unknown>>();
  pending.set(sessionId, operations);
  const operation = Promise.resolve().then(run);
  operations.add(operation);
  const cleanup = () => {
    operations.delete(operation);
    if (!operations.size && pending.get(sessionId) === operations) pending.delete(sessionId);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

export async function whenSessionHistorySettled(sessionId: string): Promise<void> {
  while (pending.get(sessionId)?.size) {
    await Promise.allSettled([...pending.get(sessionId)!]);
  }
}

/** Preserve Stop while waiting; never start a cancelled preflight later. */
export function afterSessionHistory(sessionId: string, start: () => AbortController): AbortController {
  if (!pending.get(sessionId)?.size) return start();
  const waiting = new AbortController();
  void whenSessionHistorySettled(sessionId).then(() => {
    if (waiting.signal.aborted) return;
    const running = start();
    waiting.signal.addEventListener("abort", () => running.abort(), { once: true });
  });
  return waiting;
}
