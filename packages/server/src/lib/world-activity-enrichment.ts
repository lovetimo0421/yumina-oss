export type ActivityTotal = { id: string; seconds: number; interactions?: number };
type World = { id: string; gamePath?: string | null };
/** Bounded cache shared by feed/hero/detail requests. Separate sources keep an
 * unavailable native ledger from hiding otherwise valid narrative totals. */
export function createWorldActivityEnricher(
  load: (ids: string[], kind: 'chat' | 'native') => Promise<ActivityTotal[]>,
  warn = () => console.warn('[world-playtime] aggregate unavailable'),
) {
  const cache = new Map<string, { total?: ActivityTotal; expires: number }>();
  const pending = new Map<string, Promise<void>>();
  const key = (row: World) => JSON.stringify([row.id, row.gamePath || '']);
  return async <T extends World>(rows: T[]) => {
    const now = Date.now();
    for (const kind of ['chat', 'native'] as const) {
      const selected = [...new Map(rows.filter(row => Boolean(row.gamePath) === (kind === 'native')).map(row => [key(row), row])).values()];
      const missing = selected.filter(row => (cache.get(key(row))?.expires ?? 0) <= now && !pending.has(key(row)));
      if (!missing.length) continue;
      const refresh = (async () => {
        const totals = new Map<string, ActivityTotal>();
        let failed = false;
        try {
          for (let start = 0; start < missing.length; start += 60) {
            for (const total of await load(missing.slice(start, start + 60).map(row => row.id), kind)) totals.set(total.id, total);
          }
        } catch { failed = true; warn(); }
        for (const row of missing) {
          cache.delete(key(row));
          cache.set(key(row), { total: totals.get(row.id), expires: Date.now() + (failed ? 5_000 : 60_000) });
          pending.delete(key(row));
        }
        while (cache.size > 2_000) cache.delete(cache.keys().next().value!);
      })();
      for (const row of missing) pending.set(key(row), refresh);
    }
    await Promise.all([...new Set(rows.map(row => pending.get(key(row))).filter(Boolean))]);
    return rows.map(row => {
      const total = cache.get(key(row))?.total;
      return { ...row,
        ...(row.gamePath && total?.interactions !== undefined ? { messageCount: total.interactions } : {}),
        totalPlaytimeSeconds: total?.seconds ?? null,
      };
    });
  };
}
