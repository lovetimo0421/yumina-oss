/**
 * Wallet balance → what the credit panels render.
 *
 * `balance` is the TOTAL spendable number; `addonBalance` is the slice of it
 * that never expires (check-in rewards, top-ups). The monthly grant is
 * therefore `balance - addonBalance`, and it hits 0 while the wallet is still
 * perfectly spendable.
 *
 * The panels used to drive their health signals (bar colour, "running out")
 * off that monthly slice alone. Once a player burned through the month's
 * grant, every remaining mushie lived in `addonBalance`, so the breakdown
 * rendered "0 / 2,000" under a red "running out!" banner while the header
 * right above it showed a positive balance. Creators read the contradiction as
 * "my mushies stopped working" (DM, 2026-08-31) — 970 wallets were in that
 * state on prod, 617 of them actively playing that week.
 *
 * Health signals now read TOTAL spendable balance, which is the same number
 * the server's spend gate reads (`credit-service.ts`: `ok = balance > 0`).
 * The monthly row stays as a factual breakdown, plus a line naming where the
 * mushies are actually coming from.
 */
export interface WalletHealth {
  /** Mushies left in this billing period's grant (excludes never-expiring addon). */
  monthly: number;
  /** Monthly-grant fill ratio, 0-1. Drives the progress bar's WIDTH only. */
  pct: number;
  /** Total spendable fill ratio, 0-1. Drives the bar's COLOUR and warnings. */
  spendPct: number;
  /** Total spendable balance is low — amber. */
  isLow: boolean;
  /** Total spendable balance is nearly gone — red + "running out". */
  isCritical: boolean;
  /** Nothing left at all. */
  isEmpty: boolean;
  /** Monthly grant spent, addon still funding play — explain where mushies come from. */
  spendingAddon: boolean;
}

export function walletHealth({
  balance,
  addonBalance,
  monthlyCredits,
  unlimited = false,
}: {
  balance: number | null | undefined;
  addonBalance: number | null | undefined;
  monthlyCredits: number;
  unlimited?: boolean;
}): WalletHealth {
  const bal = balance ?? 0;
  const addon = addonBalance ?? 0;
  const monthly = Math.max(bal - addon, 0);
  const ratio = (n: number) => (monthlyCredits > 0 ? Math.min(n / monthlyCredits, 1) : 0);
  const spendPct = ratio(bal);

  return {
    monthly,
    pct: ratio(monthly),
    spendPct,
    isLow: !unlimited && spendPct <= 0.2,
    isCritical: !unlimited && spendPct <= 0.05,
    isEmpty: !unlimited && bal === 0,
    spendingAddon: !unlimited && monthly <= 0 && addon > 0,
  };
}
