// Pure helpers for the measured-cost job. No database, so they are unit-testable
// and the job file stays about I/O.

export interface OurPriceRow {
  modelId: string;
  inputPricePerM: number;
  outputPricePerM: number;
  isActive: boolean;
}

export interface LivePrice {
  /** USD per 1M prompt tokens. */
  inputPerM: number;
  /** USD per 1M completion tokens. */
  outputPerM: number;
}

export interface PriceSyncPlan {
  updates: Array<{ modelId: string; from: LivePrice; to: LivePrice }>;
  deactivate: string[];
}

/**
 * Compare our active price rows with OpenRouter's live list. A row moves when
 * either side differs by more than `tolerance` (relative). A row whose model is
 * gone from OpenRouter is deactivated — it cannot be routed any more anyway.
 * `openrouter/free` is our own virtual id and is never touched.
 */
export function planPriceSync(
  ours: OurPriceRow[],
  live: Map<string, LivePrice>,
  tolerance = 0.01,
): PriceSyncPlan {
  const plan: PriceSyncPlan = { updates: [], deactivate: [] };
  for (const row of ours) {
    if (!row.isActive || row.modelId === "openrouter/free") continue;
    const l = live.get(row.modelId);
    if (!l) { plan.deactivate.push(row.modelId); continue; }
    if (!Number.isFinite(l.inputPerM) || !Number.isFinite(l.outputPerM) || l.inputPerM < 0 || l.outputPerM < 0) continue;
    const moved = (a: number, b: number) => (a === 0 ? b !== 0 : Math.abs(b - a) / a > tolerance);
    if (moved(row.inputPricePerM, l.inputPerM) || moved(row.outputPricePerM, l.outputPerM)) {
      plan.updates.push({
        modelId: row.modelId,
        from: { inputPerM: row.inputPricePerM, outputPerM: row.outputPricePerM },
        to: { inputPerM: round4(l.inputPerM), outputPerM: round4(l.outputPerM) },
      });
    }
  }
  return plan;
}

/**
 * Share of a typical reply's cost that comes from the prompt, from list prices
 * at the measured median sizes. Falls back to 0.75 (what the fleet averages)
 * when a model has no usable list price.
 */
export function inputShareFor(inputPerM: number | null | undefined, outputPerM: number | null | undefined, medianPromptTokens: number, medianOutputTokens: number): number {
  if (!inputPerM || !outputPerM || inputPerM <= 0 || outputPerM <= 0) return 0.75;
  const promptCost = inputPerM * Math.max(1, medianPromptTokens);
  const replyCost = outputPerM * Math.max(1, medianOutputTokens);
  return round4(promptCost / (promptCost + replyCost));
}

/** OpenRouter reports USD per token as strings; we store USD per million. */
export function livePriceFromOpenRouter(pricing: { prompt?: string | number | null; completion?: string | number | null } | undefined): LivePrice | null {
  if (!pricing) return null;
  // Per-token strings like "0.0000016" do not multiply cleanly in binary; round
  // to the 6 decimals a $/M price can meaningfully carry.
  const inputPerM = Math.round(Number(pricing.prompt) * 1e6 * 1e6) / 1e6;
  const outputPerM = Math.round(Number(pricing.completion) * 1e6 * 1e6) / 1e6;
  if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM)) return null;
  return { inputPerM, outputPerM };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
