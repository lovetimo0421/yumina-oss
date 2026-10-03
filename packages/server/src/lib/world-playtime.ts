import { readDb } from "../db/index.js";
import { worldPlaytimeQuery } from "./world-playtime-query.js";

const TTL_MS = 60_000;
const MAX_ENTRIES = 2_000;
const cache = new Map<string, { seconds: number | null; expires: number }>();
const pending = new Map<string, Promise<void>>();

/** Enrich already-authorized rows in one bounded query, shared by concurrent feeds.
 * Failed reads remain unavailable, never a fabricated zero. Native games have a
 * separate activity ledger; do not present their chat-session time as game time.
 */
export async function withWorldPlaytime<T extends { id: string; gamePath?: string | null }>(rows: T[]) {
  const ids = [...new Set(rows.filter(row => !row.gamePath).map(row => row.id))];
  const now = Date.now();
  const missing = ids.filter(id => (cache.get(id)?.expires ?? 0) <= now && !pending.has(id));
  if (missing.length) {
    const refresh = (async () => {
      let totals = new Map<string, number>();
      let failed = false;
      try {
        const db = await readDb();
        // The batch endpoint can serve more than a single feed page.
        for (let start = 0; start < missing.length; start += 60) {
          const result = await db.execute(worldPlaytimeQuery(missing.slice(start, start + 60)));
          for (const row of result.rows as { id: string; seconds: number }[]) totals.set(row.id, Number(row.seconds));
        }
      } catch {
        failed = true;
        console.warn("[world-playtime] aggregate unavailable");
      }
      for (const id of missing) {
        cache.delete(id);
        cache.set(id, { seconds: totals.get(id) ?? null, expires: Date.now() + (failed ? 5_000 : TTL_MS) });
        pending.delete(id);
      }
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    })();
    for (const id of missing) pending.set(id, refresh);
  }
  await Promise.all([...new Set(ids.map(id => pending.get(id)).filter(Boolean))]);
  return rows.map(row => ({ ...row, totalPlaytimeSeconds: row.gamePath ? null : cache.get(row.id)?.seconds ?? null }));
}
