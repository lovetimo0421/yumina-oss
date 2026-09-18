/**
 * Price-compatible model ids only. Do not infer these from provider redirects:
 * retired models can have very different prices from their replacements.
 */
const MODEL_PRICE_ALIASES: Record<string, readonly string[]> = {
  "google/gemini-3.1-flash-lite": ["google/gemini-3.1-flash-lite-preview"],
};

export function getModelPriceLookupIds(modelId: string): readonly string[] {
  return [modelId, ...(MODEL_PRICE_ALIASES[modelId] ?? [])];
}

export function withModelPriceAliases<T extends { modelId: string }>(entries: Iterable<T>): T[] {
  const prices = new Map(Array.from(entries, (entry) => [entry.modelId, entry]));
  for (const currentId of Object.keys(MODEL_PRICE_ALIASES)) {
    if (prices.has(currentId)) continue;
    for (const legacyId of MODEL_PRICE_ALIASES[currentId]!) {
      const legacy = prices.get(legacyId);
      if (legacy) {
        prices.set(currentId, { ...legacy, modelId: currentId });
        break;
      }
    }
  }
  return Array.from(prices.values());
}
