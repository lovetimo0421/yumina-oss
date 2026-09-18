export interface LegacyReRegistrationFreezeWallet {
  plan: string;
  balance: number;
  addonBalance: number;
  lastDailyRecovery: Date | null;
  periodEnd: Date;
}

/**
 * Identifies wallets created by the short-lived account-deletion reward
 * freeze rollout. Only these wallets copied the old account's period end into
 * both periodEnd and lastDailyRecovery while leaving a new Free wallet at
 * zero. The exact timestamp match remains identifiable after that date passes.
 */
export function isLegacyReRegistrationFreezeWallet(
  wallet: LegacyReRegistrationFreezeWallet,
): boolean {
  return wallet.plan === "free"
    && wallet.balance === 0
    && wallet.addonBalance === 0
    && wallet.lastDailyRecovery !== null
    && wallet.periodEnd.getTime() === wallet.lastDailyRecovery.getTime();
}
