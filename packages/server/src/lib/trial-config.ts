// Sonnet 4.6 free-trial seeding rule.
//
// Kept in its own module (NO db/env imports) so it stays trivially unit-testable
// and so a whole-file revert of credit-service.ts can't silently delete the rule
// without the change being visible at the call site. The original seeding was
// lost exactly this way in b49f657a (a stale-copy revert during a rebase) —
// see investigation 2026-05-28.

/** Signups whose wallet is created on/after this instant get the free trial. */
export const GROK_TRIAL_CUTOFF = new Date("2026-05-27T00:00:00Z");

/** Number of free Sonnet 4.6 messages granted to eligible new signups. */
export const GROK_TRIAL_GRANT = 3;

/** Initial `grok_trial_remaining` for a wallet created at `now`. */
export function initialGrokTrial(now: Date): number {
  return now >= GROK_TRIAL_CUTOFF ? GROK_TRIAL_GRANT : 0;
}
