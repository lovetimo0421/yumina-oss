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
