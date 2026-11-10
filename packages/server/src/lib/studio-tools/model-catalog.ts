/**
 * The model catalog as the Studio tools see it.
 *
 * A card may name a model in two places: a station's `model` (worker / quiet /
 * ui / narrator AIs) and `settings.recommendedModel` (a suggestion shown to
 * players). Both must be a model players can actually run on Yumina, i.e. an
 * active row of `model_prices`. Before this check the assistant could write
 * any string ≤200 chars and the card silently fell back at play time.
 *
 * The executor (executeApplyChanges) is synchronous and shared by the Studio
 * assistant and the card MCP, so it reads a synchronous snapshot here. The
 * snapshot comes from the price cache (lib/model-price-cache.ts), primed
 * shortly after boot and refreshed in the background whenever a lookup finds
 * it stale. Studio's own agent model is never checked here: Studio may use any
 * model.
 */
import { PLANS, type PlanId } from "../plan-config.js";
import { levenshtein } from "./fuzzy-match.js";

export interface CatalogModel {
  id: string;
  /** The lowest plan that may run it ("free" = everyone). */
  minPlan: string;
}

export type CatalogLookup =
  | { kind: "found"; model: CatalogModel }
  | { kind: "unknown"; suggestions: string[] }
  /** The catalog has not loaded (cold boot, DB down). Callers refuse rather
   *  than write an unchecked model id. */
  | { kind: "unavailable" };

/**
 * What a background AI (worker / quiet / ui / custom) runs when the player's
 * plan cannot reach the station's model. Mirrors DEFAULT_STORY_SUMMARY_MODEL in
 * lib/session-compaction.ts (not imported: that module pulls in the database);
 * model-catalog.test.ts keeps the two equal.
 */
export const BACKGROUND_FALLBACK_MODEL = "google/gemini-3.1-flash-lite";

const TTL_MS = 5 * 60 * 1000;
let snapshot: Map<string, CatalogModel> | null = null;
let loadedAt = 0;
let loading: Promise<void> | null = null;
let pinned = false;

/** Reload the snapshot from the price cache. Never throws. */
export function refreshModelCatalog(): Promise<void> {
  if (pinned) return Promise.resolve();
  loading ??= (async () => {
    try {
      const { getAllModelPrices } = await import("../model-price-cache.js");
      const rows = await getAllModelPrices();
      if (rows.length > 0) {
        snapshot = new Map(rows.map((r) => [r.modelId, { id: r.modelId, minPlan: r.minPlan || "free" }]));
        loadedAt = Date.now();
      }
    } catch (err) {
      console.error("[studio-tools/model-catalog] refresh failed:", err);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Tests: replace the catalog with a fixed list, or pin it as not loaded
 *  ("unavailable"); null goes back to the live catalog. */
export function setModelCatalogForTests(models: CatalogModel[] | "unavailable" | null): void {
  pinned = models !== null;
  snapshot = Array.isArray(models) ? new Map(models.map((m) => [m.id, m])) : null;
  loadedAt = Array.isArray(models) ? Date.now() : 0;
}

/** Synchronous lookup against the snapshot; kicks a background refresh when stale. */
export function lookupCatalogModel(rawId: string): CatalogLookup {
  if (!pinned && Date.now() - loadedAt > TTL_MS) void refreshModelCatalog();
  if (!snapshot) return { kind: "unavailable" };
  const id = rawId.trim();
  const hit = snapshot.get(id);
  if (hit) return { kind: "found", model: hit };
  return { kind: "unknown", suggestions: closeModelIds(id, [...snapshot.keys()]) };
}

/** Up to three catalog ids that look like what was meant. */
function closeModelIds(query: string, ids: string[]): string[] {
  const q = query.toLowerCase();
  const qTail = q.slice(q.lastIndexOf("/") + 1);
  if (!qTail) return [];
  const scored: Array<{ id: string; score: number }> = [];
  for (const id of ids) {
    const lower = id.toLowerCase();
    const tail = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (lower.includes(qTail) || (tail.length >= 4 && qTail.includes(tail))) score = 0;
    else score = levenshtein(qTail, tail) / Math.max(qTail.length, tail.length);
    if (score <= 0.34) scored.push({ id, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)).slice(0, 3).map((s) => s.id);
}

/** "Platinum" for "plus"; the raw id for a plan this build does not know. */
export function planDisplayName(plan: string): string {
  return PLANS[plan as PlanId]?.displayName ?? plan;
}

/** The error text for a model id that is not in the catalog (or cannot be checked). */
export function catalogModelError(field: string, rawId: string, lookup: Exclude<CatalogLookup, { kind: "found" }>): string {
  if (lookup.kind === "unavailable") {
    return `${field}: the model catalog could not be loaded just now, so "${rawId}" cannot be checked. Try again in a moment, or leave ${field} out.`;
  }
  const hint = lookup.suggestions.length > 0 ? ` Close matches: ${lookup.suggestions.map((s) => `"${s}"`).join(", ")}.` : "";
  return `${field}: "${rawId}" is not a model players can run on Yumina (not in the model catalog).${hint} Use an exact catalog id, or leave ${field} out to follow the player's own choice.`;
}

// Prime once after boot so the first station write does not find it cold.
// Not under a test runner: tests pin the catalog with setModelCatalogForTests.
if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
  setTimeout(() => { void refreshModelCatalog(); }, 3000).unref?.();
}
