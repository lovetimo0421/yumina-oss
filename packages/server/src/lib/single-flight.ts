/**
 * Collapse concurrent calls of an async refresh into one.
 *
 * The failure this prevents is a cache stampede: a TTL cache whose "is it
 * stale?" flag is only updated AFTER its refresh resolves will let every caller
 * that arrives during the refresh start another one. Callers arrive in bursts
 * (a `Promise.all` over thousands of rows enters the check synchronously), so
 * an expiry landing mid-burst becomes hundreds of identical DB queries at once
 * — 390 concurrent model-price SELECTs in a single second drained the
 * 100-connection pool and starved the process on 2026-08-15.
 *
 * Rejections are not cached: a failed refresh clears the slot so the next
 * caller retries rather than inheriting the failure forever.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    // Callers arriving while a run is active await that same run.
    inFlight ??= fn().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
