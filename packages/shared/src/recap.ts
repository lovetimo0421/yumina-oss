/**
 * The recap ("前情提要"): what the AI is told about scenes that no longer fit
 * in story memory. It is sent with every turn, so its size is a cost the
 * player pays on each reply, and the player chooses it as a share of their
 * story memory.
 *
 * Measured 2026-10-30 on 14 real long sessions (168 questions about the
 * first 300 messages, answered from the recap alone): the old rolling summary
 * got 8%, the layered recap 51%. The layered recap is the only recap now;
 * this share bounds how large it may grow.
 */

export const RECAP_SHARES = ['off', 'lean', 'standard', 'detailed'] as const;
export type RecapShare = (typeof RECAP_SHARES)[number];

export const RECAP_SHARE_RATIO: Readonly<Record<RecapShare, number>> = {
  off: 0,
  lean: 0.15,
  standard: 0.25,
  detailed: 0.4,
};

/** A recap smaller than this cannot hold even a few chapters. */
export const MIN_RECAP_TOKENS = 1_500;

/** Largest the recap may grow for this story memory and share; 0 when off. */
export function recapBudgetTokens(storyMemory: number, share: RecapShare): number {
  const ratio = RECAP_SHARE_RATIO[share] ?? 0;
  if (ratio <= 0) return 0;
  return Math.max(MIN_RECAP_TOKENS, Math.round(storyMemory * ratio));
}

export function isRecapShare(value: unknown): value is RecapShare {
  return typeof value === 'string' && (RECAP_SHARES as readonly string[]).includes(value);
}

/**
 * The share a turn runs with. An explicit choice always wins; unchosen, the
 * recap is on at standard for everyone (owner decision 2026-10-30: about
 * 1,100 long stories a fortnight had no recap and simply dropped what fell
 * out of story memory). A player who explicitly uninstalled the memory
 * feature is the one exception; the server checks that, not this.
 */
export function resolveRecapShare(args: { chosen: unknown }): RecapShare {
  return isRecapShare(args.chosen) ? args.chosen : 'standard';
}
