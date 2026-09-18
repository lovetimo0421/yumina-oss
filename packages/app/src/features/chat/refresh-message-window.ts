interface Cursor { id: string; createdAt: string }
interface Page<T> { data: T[]; meta?: { hasMore?: boolean } }
function compare(a: Cursor, b: Cursor): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Refresh only the loaded range, in bounded pages. An authoritative reload of
 * that range handles deleted/reverted rows as well as edits; a blind union
 * with cached history would resurrect deleted messages. Commit atomically. */
export async function refreshMessageWindow<T extends Cursor>(
  existing: readonly T[],
  load: (before?: Cursor) => Promise<Page<T>>,
): Promise<{ messages: T[]; hasEarlierMessages: boolean } | null> {
  const oldest = existing.find((row) => !row.id.startsWith("__pending_"));
  const maxPages = Math.ceil(existing.length / 200) + 1;
  let before: Cursor | undefined;
  let result: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const response = await load(before);
    if (!Array.isArray(response.data)) return null;
    const first = response.data[0];
    if (before && first && compare(first, before) >= 0) return null;
    result = [...response.data, ...result];
    if (!response.meta?.hasMore || !first || !oldest || compare(first, oldest) <= 0) {
      const retained = oldest && response.meta?.hasMore
        ? result.filter((row) => compare(row, oldest) >= 0) : result;
      return {
        messages: [...new Map(retained.map((row) => [row.id, row])).values()],
        hasEarlierMessages: Boolean(response.meta?.hasMore) || retained.length < result.length,
      };
    }
    before = first;
  }
  // A very large remote advance exhausted the known loaded-range budget.
  // Leave the working transcript intact rather than splice in a history gap.
  return null;
}
