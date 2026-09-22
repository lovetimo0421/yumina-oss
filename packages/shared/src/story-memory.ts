/**
 * Story memory: how much of the conversation is sent word for word.
 *
 * This is the one memory dial a player is asked to set. What a PLAN buys is
 * how much of the WORLD we carry (`memoryCap`), which is charged separately
 * and is never trimmed to make room for chat.
 *
 * ── Why the default is not simply 16,000 ──────────────────────────────
 *
 * Every account that predates this setting is running whatever `maxContext`
 * they have, which for most people is the 200,000 default bounded by their
 * plan. Resolving an absent `storyMemory` to 16,000 would cut those prompts
 * the moment the code deploys: a large, silent quality change to people who
 * never asked for it. Owner decision 2026-09-22: new accounts start at
 * 16,000, everyone else keeps what they have until they move the dial
 * themselves, and the announcement is what invites them to.
 *
 * So an ABSENT value means "not chosen yet" and resolves by account age.
 * An EXPLICIT value always wins, on any account, whatever the flag says —
 * that is what makes the announcement actionable before the flag is flipped.
 */

/** Suggested and new-account default. */
export const SUGGESTED_STORY_MEMORY = 16_000;
export const MIN_STORY_MEMORY = 2_048;
export const MAX_STORY_MEMORY = 200_000;

export interface StoryMemoryInput {
  /** What the account has saved, if it has ever chosen. */
  saved?: number | null;
  /** The account's overall per-request ceiling, already clamped to the plan. */
  maxContext: number;
  /** When the account was created. */
  accountCreatedAt?: Date | null;
  /**
   * Accounts created at or after this instant default to the suggestion.
   * `null` (env unset) = nobody is moved by default, so the code can ship
   * dark and the behaviour change is a separate, revertible env flip.
   */
  newAccountsFrom?: Date | null;
}

export interface StoryMemoryResolution {
  /** Tokens of conversation kept word for word. */
  tokens: number;
  /** How we got there, for logs and for the settings UI to explain itself. */
  source: "chosen" | "new-account-default" | "carried-over";
}

/**
 * Resolve the effective story memory for one turn.
 *
 * Never returns more than `maxContext`: the overall ceiling still wins, so a
 * Free account that chose 200,000 is still bounded by its 64,000 plan cap.
 */
export function resolveStoryMemory(input: StoryMemoryInput): StoryMemoryResolution {
  const ceiling = Math.max(MIN_STORY_MEMORY, Math.floor(input.maxContext));
  const cap = (n: number) => Math.min(ceiling, Math.max(MIN_STORY_MEMORY, Math.floor(n)));

  if (typeof input.saved === "number" && Number.isFinite(input.saved) && input.saved > 0) {
    return { tokens: cap(input.saved), source: "chosen" };
  }

  const from = input.newAccountsFrom;
  const created = input.accountCreatedAt;
  const isNewAccount =
    !!from && !!created && Number.isFinite(created.getTime()) && created.getTime() >= from.getTime();

  return isNewAccount
    ? { tokens: cap(SUGGESTED_STORY_MEMORY), source: "new-account-default" }
    : { tokens: ceiling, source: "carried-over" };
}
