const DEEPSEEK_LATEST_PRICING_MODELS = new Set([
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
]);

export function usesDeepSeekLatestPricing(modelId: string): boolean {
  return DEEPSEEK_LATEST_PRICING_MODELS.has(modelId);
}
