import type { StreamChunk } from "./llm/types.js";

/** Store the provider's final charge once. Cache pricing is already included. */
function cacheCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

export function usageObservation(usage?: StreamChunk["usage"]) {
  const cost = usage?.providerCostUsd;
  return {
    providerCostUsd:
      typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? cost.toFixed(12)
        : null,
    providerRequestId: usage?.providerRequestId?.slice(0, 200) || null,
    tokenMeasurement: usage ? "provider" : "estimated",
    // undefined leaves the column out of the insert entirely.
    cacheReadTokens: cacheCount(usage?.cacheReadTokens),
    cacheWriteTokens: cacheCount(usage?.cacheWriteTokens),
  };
}
