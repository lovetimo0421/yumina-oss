/**
 * Creator tip-eligibility floor — applies to MUSHIE GIFTS only.
 *
 * A creator can receive mushie gifts once their works, summed together, clear
 * both a download and an interaction floor. Real-money tips are deliberately
 * NOT gated: they can't mint credits, Stripe holds the funds, and payout
 * requires a verified Connect account — so anyone may sponsor any creator at
 * any time.
 *
 * The floors are intentionally low: they are a spam floor, not the anti-farm
 * defense. The 2026-08-18 farming audit showed a recipient traction floor is
 * the wrong tool for that — the largest farm's main account had real traction
 * and passed 500/2000, while ~97% of honest creators did not. The anti-farm
 * control is on the SENDER instead (lib/free-tier-gift-cap.ts): never-paid
 * free accounts can only gift a token amount per month, so alt fleets have
 * nothing meaningful to send.
 *
 * Interactions are the aggregate `messageCount` across the creator's worlds
 * (the denormalised per-world message total), matching what the platform shows
 * as a card's activity.
 */

/** Summed download_count across the creator's worlds. */
export const MIN_CREATOR_TIP_DOWNLOADS = 10;
/** Summed message_count across the creator's worlds. */
export const MIN_CREATOR_TIP_MESSAGES = 100;

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function creatorMeetsTipThreshold(
  totalDownloads: number,
  totalMessages: number
): boolean {
  return (
    nonNegative(totalDownloads) >= MIN_CREATOR_TIP_DOWNLOADS &&
    nonNegative(totalMessages) >= MIN_CREATOR_TIP_MESSAGES
  );
}
