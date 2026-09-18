/**
 * Stale-while-revalidate helper for Zustand stores.
 *
 * - Data fresh  (< freshMs):  skip fetch entirely
 * - Data stale  (< staleMs):  return cached, refresh in background
 * - Data expired (>= staleMs) or missing: show spinner, fetch normally
 */
export interface CachedFetchOpts {
  freshMs?: number;
  staleMs?: number;
}

const DEFAULTS = { freshMs: 30_000, staleMs: 300_000 };

export function cachedFetch(
  hasData: () => boolean,
  getState: () => { lastFetchedAt: number | null; loading: boolean },
  doFetch: () => Promise<void>,
  setLoading: (v: boolean) => void,
  opts?: CachedFetchOpts,
): Promise<void> {
  const { freshMs, staleMs } = { ...DEFAULTS, ...opts };
  const { lastFetchedAt, loading } = getState();

  // Dedup: if a fetch is already in flight, skip
  if (loading) return Promise.resolve();

  const age = lastFetchedAt ? Date.now() - lastFetchedAt : Infinity;

  // Fresh — skip entirely
  if (hasData() && age < freshMs) return Promise.resolve();

  // Stale — background refresh (no spinner)
  if (hasData() && age < staleMs) {
    doFetch().catch(() => {});
    return Promise.resolve();
  }

  // Expired or no data — show spinner
  setLoading(true);
  return doFetch();
}
