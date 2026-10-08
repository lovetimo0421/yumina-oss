// ─── Model Price Cache ───────────────────────────────────────────────
// Loads model prices from the database and caches them in memory.
// Refreshes every 5 minutes. Used by credit-service.ts to calculate costs.

import { db } from "../db/index.js";
import { modelPrices } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getModelPriceLookupIds, withModelPriceAliases } from "./model-price-aliases.js";
import { singleFlight } from "./single-flight.js";
import { isNativeVoiceModel } from "./voice-native-models.js";

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
  return withModelPriceAliases(cache.values()).filter(price => !isNativeVoiceModel(price.modelId));
}

/** Check if a model is available on the official API. */
export async function isOfficialModel(modelId: string): Promise<boolean> {
  return !isNativeVoiceModel(modelId) && (await getModelPrice(modelId)) !== null;
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

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const LIST_PRICE_TTL = 6 * 60 * 60 * 1000;
let listPrices: Map<string, ModelPriceEntry> | null = null;
let listPricesLoadedAt = 0;
let listPricesLoading: Promise<void> | null = null;

/** OpenRouter's public list price for a model that has no model_prices row
 *  (Studio models are billed from OpenRouter's reported cost with no markup).
 *  For estimates only; billing never reads this. */
export async function getOpenRouterListPrice(modelId: string): Promise<ModelPriceEntry | null> {
  if (!listPrices || Date.now() - listPricesLoadedAt > LIST_PRICE_TTL) {
    listPricesLoading ??= (async () => {
      try {
        const res = await fetch(OPENROUTER_MODELS_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return;
        const json = await res.json() as { data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
        const next = new Map<string, ModelPriceEntry>();
        for (const model of json.data ?? []) {
          const input = Number(model.pricing?.prompt) * 1e6;
          const output = Number(model.pricing?.completion) * 1e6;
          if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
          next.set(model.id, { modelId: model.id, inputPricePerM: input, outputPricePerM: output, contextThreshold: null,
            inputPriceAboveThreshold: null, outputPriceAboveThreshold: null, minPlan: "free", markupMultiplier: 1 });
        }
        if (next.size) { listPrices = next; listPricesLoadedAt = Date.now(); }
      } catch {
        /* keep the previous catalog */
      } finally {
        listPricesLoading = null;
      }
    })();
    await listPricesLoading;
  }
  return listPrices?.get(modelId) ?? null;
}
