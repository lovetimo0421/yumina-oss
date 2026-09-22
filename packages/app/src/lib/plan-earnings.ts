/**
 * Where the two mushie numbers a player sees come from.
 *
 * The plans page and the profile plan block both print "N a month, and quests
 * can add up to M". They used to derive M inline, in two places, from three
 * different server fields — which is how the cards once still advertised the
 * old board caps weeks after the board was resized. One rule, one file.
 *
 * The pile and the ceiling stay APART everywhere they are shown. The pile is
 * what the plan owes you; the ceiling is what you can go and earn. Summed,
 * they advertise a number nobody receives in a month they do not play.
 */

/** The slice of the credit store these functions read. */
export interface EarningsSource {
  /** 1 = legacy lineup, 2 = the 2026-09 lineup. */
  planVersion: number;
  /** Where daily rewards are earned. Only "quests" has a ceiling. */
  rewards: "quests" | "check_in";
  /** Per-plan lineup-2 payload, when the wallet is on lineup 2. */
  lineup: Record<string, { monthlyCredits: number; questMonthlyCap: number; questMaxTotal?: number }> | null;
  /** Per-plan board cap plus reachable forge rungs, for legacy wallets. */
  questCaps: Record<string, number> | null;
}

/**
 * Most the quest board and the forge can add to a plan in one cycle, or null
 * when this wallet has no board to earn on.
 *
 * `questMaxTotal` already folds in the forge rungs the tier can reach;
 * `questMonthlyCap` is the board alone and is only a fallback for a server
 * that has not shipped the total yet.
 */
export function questCeilingFor(plan: string | null | undefined, source: EarningsSource): number | null {
  if (!plan) return null;
  if (source.planVersion === 2) {
    const tier = source.lineup?.[plan];
    if (!tier) return null;
    const ceiling = tier.questMaxTotal ?? tier.questMonthlyCap;
    return ceiling > 0 ? ceiling : null;
  }
  // Legacy wallets earn on the same board since the 2026-09-21 flip, but only
  // while the server says so — the kill switch puts them back on check-ins.
  if (source.rewards !== "quests") return null;
  const cap = source.questCaps?.[plan];
  return cap && cap > 0 ? cap : null;
}

/**
 * The guaranteed pile for a plan. Prefers the lineup payload, because the
 * wallet's own `monthlyCredits` is whatever was last granted and can lag a
 * plan change by a cycle.
 */
export function monthlyPileFor(
  plan: string | null | undefined,
  source: EarningsSource,
  walletMonthlyCredits?: number | null,
): number | null {
  if (plan && source.planVersion === 2) {
    const tier = source.lineup?.[plan];
    if (tier?.monthlyCredits) return tier.monthlyCredits;
  }
  return walletMonthlyCredits && walletMonthlyCredits > 0 ? walletMonthlyCredits : null;
}
