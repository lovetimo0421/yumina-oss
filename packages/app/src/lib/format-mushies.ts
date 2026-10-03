/**
 * Mushie balances are fractional (background billing deducts in 0.1 steps —
 * see server provider-cost.ts). Displays used to Math.floor to a whole number,
 * so a 0.2 session-memory charge rendered as a FULL mushie vanishing
 * (2199.8 → "2199"), which a player read as the platform rounding up charges
 * (community thread, 2026-08-28). Keep one decimal, floored, so the display
 * never overstates what the user has.
 */

/** Floor to 0.1-mushie precision — safe to feed to Intl/i18n formatters. */
export function floorMushies(balance: number | null | undefined): number {
  return Math.floor((balance ?? 0) * 10) / 10;
}

/** Locale-formatted balance: whole balances stay integers ("2,200"),
 *  fractional ones keep one decimal ("2,199.8"). */
export function formatMushieBalance(balance: number | null | undefined): string {
  return floorMushies(balance).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** Wallet-panel amount: whole Mushies from 1,000 up (587,463.9 reads as noise),
 *  tenths below (most of what a cheap turn costs). Floored like everything
 *  else here — the wallet panel used to round, so a 5,527.9 balance read
 *  5,528 inside the popup while the pill read 5,527 (community thread
 *  2026-10-01, "显示的数字跟点开的数字是不一样的"). */
export function formatWalletAmount(amount: number, locale?: string): string {
  const shown = Math.abs(amount) >= 1000 ? Math.trunc(amount) : Math.trunc(amount * 10 + Math.sign(amount) * 1e-9) / 10;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(shown);
}

/** Header-pill balance: compact "90.9K" from 10,000 up, otherwise the same
 *  number the wallet panel shows, so opening the pill never changes it. */
export function formatMushiePill(balance: number | null | undefined, locale?: string): string {
  const n = balance ?? 0;
  if (n >= 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}K`;
  return formatWalletAmount(n, locale);
}
