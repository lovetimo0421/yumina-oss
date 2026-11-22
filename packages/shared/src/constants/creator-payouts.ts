/**
 * Creator tip earnings: where they can be paid out, and what they buy in the
 * shop instead.
 *
 * Payout accounts were all created as US accounts (Stripe defaults to the
 * platform's country when none is given), so a creator anywhere else was asked
 * for a US identity and bank and could never finish (2026-11-04, Tsuna: "if
 * you are from outside US retiring money is kinda painful, or impossible").
 * A US platform can pay out on its own to the US, UK, EEA, Canada and
 * Switzerland; everyone, wherever they live, can spend earnings on mushies.
 */

/** The mushie packs on sale, by Stripe price. Prices in US cents. Must match
 *  the live Stripe prices and the pack list on the plans page. */
export const MUSHIE_PACKS: readonly { priceId: string; mushies: number; cents: number }[] = [
  { priceId: "price_1TUwUSAqpxe2iPklumjLT2fd", mushies: 1000, cents: 299 },
  { priceId: "price_1TUwUSAqpxe2iPklo6JM6sw1", mushies: 3000, cents: 699 },
  { priceId: "price_1TUwUSAqpxe2iPkl1NoT7YPm", mushies: 10000, cents: 1999 },
  { priceId: "price_1TUwUSAqpxe2iPkltB1bkYNB", mushies: 20000, cents: 3499 },
  { priceId: "price_1TUwUSAqpxe2iPkl30o6NPhP", mushies: 44000, cents: 6899 },
  { priceId: "price_1TUwURAqpxe2iPkl6gvLa1cs", mushies: 116000, cents: 16899 },
];

/**
 * Extra mushies when a pack is paid with tip earnings. Card payments cost
 * Stripe about 2.9% + 30¢ and a payout costs transfer and payout fees; earnings
 * spent in the shop cost neither, so a small part of that saving goes back to
 * the creator. Stacks with the membership pack bonus.
 */
export const EARNINGS_PACK_BONUS_PCT = 5;

/** Mushies per cent when converting an amount that is not a pack (what is
 *  left after buying packs): the smallest pack's rate, before bonuses. */
export const EARNINGS_MUSHIES_PER_CENT = 1000 / 299;

/** The smallest amount that can be converted on its own: 50¢. */
export const EARNINGS_MIN_CONVERT_CENTS = 50;

/** Mushies a pack or an amount of earnings buys, before bonuses. */
export function earningsBaseMushies(cents: number, priceId?: string | null): number {
  const pack = priceId ? MUSHIE_PACKS.find((p) => p.priceId === priceId) : undefined;
  if (pack) return pack.mushies;
  return Math.floor(Math.max(0, cents) * EARNINGS_MUSHIES_PER_CENT);
}

/** With the earnings bonus and the member's pack bonus, added together. */
export function earningsMushiesWithBonus(baseMushies: number, memberBonusPct: number): number {
  return Math.round(baseMushies * (1 + (EARNINGS_PACK_BONUS_PCT + Math.max(0, memberBonusPct)) / 100));
}

/**
 * Countries a US Stripe platform can pay out to without Global Payouts:
 * the US, UK, EEA, Canada and Switzerland. Each also has to be switched on in
 * the Stripe Dashboard (Connect settings → onboarding countries).
 */
export const PAYOUT_COUNTRIES = [
  "US", "CA", "GB", "CH",
  // EEA
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT",
  "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
] as const;

export type PayoutCountry = (typeof PAYOUT_COUNTRIES)[number];

export function isPayoutCountry(value: unknown): value is PayoutCountry {
  return typeof value === "string" && (PAYOUT_COUNTRIES as readonly string[]).includes(value);
}
