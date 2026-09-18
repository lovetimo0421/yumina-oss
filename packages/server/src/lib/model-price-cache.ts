// ─── Model Price Cache ───────────────────────────────────────────────
// Loads model prices from the database and caches them in memory.
// Refreshes every 5 minutes. Used by credit-service.ts to calculate costs.

import { db } from "../db/index.js";
import { modelPrices } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getModelPriceLookupIds, withModelPriceAliases } from "./model-price-aliases.js";
import { singleFlight } from "./single-flight.js";

export interface ModelPriceEntry {
  modelId: string;
  inputPricePerM: number;
  outputPricePerM: number;
  contextThreshold: number | null;
  inputPriceAboveThreshold: number | null;
  outputPriceAboveThreshold: number | null;
  minPlan: string;
  markupMultiplier: number;
}

let cache: Map<string, ModelPriceEntry> = new Map();
let lastLoaded = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function refreshCache(): Promise<void> {
  try {
    const rows = await db.select().from(modelPrices).where(eq(modelPrices.isActive, true));
    const newCache = new Map<string, ModelPriceEntry>();
    for (const row of rows) {
      newCache.set(row.modelId, {
        modelId: row.modelId,
        inputPricePerM: row.inputPricePerM,
        outputPricePerM: row.outputPricePerM,
        contextThreshold: row.contextThreshold,
        inputPriceAboveThreshold: row.inputPriceAboveThreshold,
        outputPriceAboveThreshold: row.outputPriceAboveThreshold,
        minPlan: row.minPlan,
        markupMultiplier: row.markupMultiplier ?? 1.0,
      });
    }
    cache = newCache;
    lastLoaded = Date.now();
  } catch (err) {
    // If DB query fails, keep the stale cache rather than clearing it
    console.error("[ModelPriceCache] Failed to refresh:", err);
  }
}

// `lastLoaded` is only stamped after refreshCache()'s await resolves, so
// without collapsing, every caller that reaches a stale check before the first
// refresh returns starts its OWN refresh. Callers arrive in bursts —
// loadMemoryUsage does `Promise.all(rows.map(… calculateCost …))` over thousands
// of usage rows and each one hits getModelPrice — so an expiry landing
// mid-burst became a thundering herd: 390 concurrent identical model-price
// SELECTs in one second on 2026-08-15 13:36:56, each 500-620ms, which drained
// the 100-connection pool and starved every other request in the process (the
// 502 burst that started at 13:37).
const refreshOnce = singleFlight(refreshCache);

async function ensureLoaded(): Promise<void> {
  if (Date.now() - lastLoaded <= CACHE_TTL && cache.size > 0) return;
  await refreshOnce();
}

/** Get pricing for a specific model. Returns null if model is not in the price table. */
export async function getModelPrice(modelId: string): Promise<ModelPriceEntry | null> {
  await ensureLoaded();
  // Deploy-safe migration path: a database may still have only the deprecated
  // Preview row when code starts redirecting requests to the GA model id.
  for (const candidateId of getModelPriceLookupIds(modelId)) {
    const price = cache.get(candidateId);
    if (price) return candidateId === modelId ? price : { ...price, modelId };
  }
  return null;
}

/** Get all active model prices. */
export async function getAllModelPrices(): Promise<ModelPriceEntry[]> {
  await ensureLoaded();
  return withModelPriceAliases(cache.values());
}

/** Check if a model is available on the official API. */
export async function isOfficialModel(modelId: string): Promise<boolean> {
  return (await getModelPrice(modelId)) !== null;
}

/**
 * Load prices once, up front, so a following burst of calculateCost() calls all
 * hit a warm in-memory map. Cheap no-op when the cache is fresh; the callers
 * that need it are the ones that fan out over thousands of usage rows.
 */
export async function warmModelPriceCache(): Promise<void> {
  await ensureLoaded();
}

/** Force refresh the cache (e.g., after admin updates prices). */
export async function invalidateModelPriceCache(): Promise<void> {
  lastLoaded = 0;
  await refreshCache();
}
