/**
 * Server-wide OpenRouter model catalog — the authoritative source for each
 * model's real context window.
 *
 * OpenRouter's `/api/v1/models` is public (no key) and returns `context_length`
 * per model. We cache it process-wide (a model's window is global, not per-user)
 * with a TTL so the context-budget pre-trim uses live numbers instead of a
 * hardcoded table that goes stale whenever OpenRouter adds a model or changes an
 * endpoint. The hardcoded `getModelContextWindow` map remains only as a
 * cold-start fallback (before the first successful fetch) and for non-OpenRouter
 * BYOK providers.
 *
 * Correctness does NOT depend on this being warm: the OpenRouter
 * context-compression plugin (see openrouter.ts) is the hard guarantee that a
 * request fits the routed endpoint. This catalog only improves *what we choose
 * to drop* during our own pre-trim.
 */
const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h — model windows change rarely

let catalog = new Map<string, number>(); // modelId -> context_length
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

/**
 * Refresh the catalog if stale. TTL-guarded and de-duped, so calling it on every
 * request is a cheap no-op once warm. Fire-and-forget from the request path
 * (`void ensureOpenRouterCatalog()`); never throws — on failure it keeps the
 * last good (or empty) map and callers fall back to the hardcoded table.
 */
export function ensureOpenRouterCatalog(): Promise<void> {
  if (catalog.size > 0 && Date.now() - fetchedAt < CATALOG_TTL_MS) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(CATALOG_URL, { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const json = (await res.json()) as { data?: Array<{ id?: string; context_length?: number }> };
      const next = new Map<string, number>();
      for (const m of json.data ?? []) {
        if (m.id && typeof m.context_length === "number" && m.context_length > 0) {
          next.set(m.id, m.context_length);
        }
      }
      if (next.size > 0) {
        catalog = next;
        fetchedAt = Date.now();
      }
    } catch {
      // Network/parse failure — keep the previous map; callers use the fallback.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Live context window for a model id, or null if the catalog hasn't seen it
 *  (cold start, or a model not served by OpenRouter — e.g. direct-BYOK / custom). */
export function getCatalogContextWindow(modelId: string): number | null {
  return catalog.get(modelId) ?? null;
}

/** Register windows learned from another provider's catalog (e.g. the per-user
 *  `GET /api/models` fetch for direct BYOK keys). Only positive values are kept. */
export function registerContextWindows(models: Array<{ id: string; contextLength?: number }>): void {
  for (const m of models) {
    if (m.contextLength && m.contextLength > 0) catalog.set(m.id, m.contextLength);
  }
}
