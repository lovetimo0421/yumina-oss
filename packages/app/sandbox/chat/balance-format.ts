/** Mushie-balance formatters for the composer's model pill. Pure so the app
 * test suite can import them without the sandbox runtime. */

/** Full with thousands separators through 100k, then abbreviated (123k / 1.2M)
 * so the model-pill tag never overflows on large balances. */
export function formatBalance(n: number): string {
  const v = Math.floor(n);
  if (v <= 100_000) return v.toLocaleString();
  if (v < 1_000_000) return `${Math.round(v / 1_000)}k`;
  const m = v / 1_000_000;
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

/** Narrow toolbars keep the same balance precision as the regular display. */
export function formatBalanceCompact(n: number): string {
  return formatBalance(n);
}
