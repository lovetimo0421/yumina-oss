/** The same fixed boundary as check-ins, quests and Bonus expiry: 04:00 UTC+8. */
const RESET_OFFSET_MS = 20 * 60 * 60 * 1000;
export const CREDIT_DAY_MS = 86_400_000;
export const FREE_CREDIT_CYCLE_MS = 30 * CREDIT_DAY_MS;

/** Admin-assigned Free is still Free; Stripe/WeChat cycle anchors belong to billing. */
export function isFreeCreditCycle(wallet: { plan: string; subscriptionSource: string | null }): boolean {
  return wallet.plan === "free" && (wallet.subscriptionSource === null || wallet.subscriptionSource === "comp");
}

/** Round forward so aligning an existing cycle can never expire its balance early. */
export function globalCreditResetAtOrAfter(at: Date): Date {
  return new Date(Math.ceil((at.getTime() - RESET_OFFSET_MS) / CREDIT_DAY_MS) * CREDIT_DAY_MS + RESET_OFFSET_MS);
}

/** Used by the sweep's indexed cutoff predicates; exactly on a boundary includes it. */
export function previousGlobalCreditReset(at: Date): Date {
  return new Date(Math.floor((at.getTime() - RESET_OFFSET_MS) / CREDIT_DAY_MS) * CREDIT_DAY_MS + RESET_OFFSET_MS);
}
