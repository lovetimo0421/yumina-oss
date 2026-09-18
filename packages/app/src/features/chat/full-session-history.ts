/** GET /sessions/:id and the chat store hold only the newest window of
 *  messages (bounded after the 2026-08-11 event-loop outage). Anything that
 *  needs the WHOLE conversation — like the transcript export — must page
 *  older history through the keyset endpoint until the server reports
 *  nothing earlier remains. Each page is server-bounded, so this stays safe
 *  for mega sessions. */

const FULL_HISTORY_PAGE_LIMIT = 500;

function defaultApiBase(): string {
  // Vite injects import.meta.env; under the node test runner it is undefined.
  return (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || "";
}

export async function fetchFullSessionMessages<T extends { id: string; createdAt: string }>(
  sessionId: string,
  newestWindow: T[],
  options?: { messageTotal?: number; errorMessage?: string; apiBase?: string },
): Promise<T[]> {
  let all = newestWindow;
  const total = options?.messageTotal;
  if (typeof total === "number" && total > 0 && all.length >= total) return all;
  const apiBase = options?.apiBase ?? defaultApiBase();

  for (;;) {
    // Oldest REAL row is the cursor (skip optimistic __pending_* placeholders).
    const oldest = all.find((m) => !m.id.startsWith("__pending_"));
    if (!oldest?.createdAt) break;

    const params = new URLSearchParams({
      before: oldest.createdAt,
      beforeId: oldest.id,
      limit: String(FULL_HISTORY_PAGE_LIMIT),
    });
    const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages?${params.toString()}`, {
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(options?.errorMessage || `Failed to load full chat history (${res.status})`);
    }
    const { data, meta } = (await res.json()) as { data?: T[]; meta?: { hasMore?: boolean } };
    const older = Array.isArray(data) ? data : [];
    const existingIds = new Set(all.map((m) => m.id));
    const fresh = older.filter((m) => !existingIds.has(m.id));
    if (fresh.length === 0) break;
    all = [...fresh, ...all];
    if (!meta?.hasMore) break;
  }
  return all;
}
