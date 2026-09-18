/**
 * Per-key FIFO promise chain for serializing fire-and-forget background jobs
 * (one chain per play session). Shared by the three summary systems: story
 * compaction, session memory, and Summaryception.
 *
 * The map entry is a promise derived from the caller-facing `current`, used
 * only to order the next enqueue and to clean the map up after the chain
 * settles. Nothing ever attaches a rejection handler to the map entry, so it
 * must never be left rejectable — `.finally()` re-propagates rejections, and
 * an orphaned rejected entry fires Node's `unhandledRejection` on every
 * failed background job even though the caller handled the returned promise
 * (duplicate error logs + false crash telemetry). The next enqueue already
 * neutralizes failures via `previous.catch(...)`, so swallowing on the stored
 * branch loses nothing.
 */
export function enqueueKeyedJob<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  job: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(job);
  let stored: Promise<unknown>;
  stored = current.then(() => undefined, () => undefined).finally(() => {
    if (chains.get(key) === stored) {
      chains.delete(key);
    }
  });
  chains.set(key, stored);
  return current;
}
