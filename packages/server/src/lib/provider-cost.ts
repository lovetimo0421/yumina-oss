/**
 * OpenRouter reports `usage.cost` as the total USD-denominated credit amount
 * charged to the account for a generation. Keep validation and conversion in
 * one place so every official OpenRouter model follows the same billing path.
 */
export function normalizeProviderCostUsd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** $1 of provider cost equals 1,000 Yumina credits, rounded up to 0.1 credit. */
export function providerCostUsdToCredits(costUsd: number, multiplier = 1): number {
  return Math.ceil(costUsd * multiplier * 1000 * 10) / 10;
}
