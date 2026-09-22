/**
 * How much of the overall window the lorebook may spend on TRIGGERED entries.
 *
 * ── The problem this solves ───────────────────────────────────────────
 *
 * The plan cap bounds the whole request, not the world, and the world is
 * assembled first. So on a small plan a large world ate the conversation:
 * with a 64,000 cap and a 55,000 world, the player's 16,000 of story memory
 * silently became 9,000, and past a certain size became nothing at all. The
 * product promises story memory is yours on every plan; that promise only
 * held while worlds stayed small.
 *
 * Story memory is therefore a RESERVATION, not a leftover. The lorebook
 * budget is what remains after setting it aside, so triggered entries trim
 * to make room rather than the conversation being squeezed out. Nothing
 * about which entries MATCH changes: this only decides how many of the
 * already-matched ones survive, using the trimming the matcher already does.
 *
 * ── What this cannot fix ──────────────────────────────────────────────
 *
 * Always-send entries bypass the lorebook budget entirely, by design: they
 * are the world's spine and trimming them breaks the character. A world
 * whose always-send alone fills the cap still cannot fit, and that case
 * belongs to the caller to detect and report, not to this function.
 */

/** Never hand the matcher a negative budget. */
const MIN_LOREBOOK_BUDGET = 0;

export interface LorebookBudgetInput {
  /** Ceiling on the whole request, already clamped to plan and model. */
  maxContext: number;
  /** Tokens held back for the reply itself. */
  outputReserve: number;
  /** Conversation the player is guaranteed, from resolveStoryMemory. */
  storyMemory: number;
  /**
   * Where that number came from. "carried-over" means the account never
   * chose and is simply running its whole window, which is a statement of
   * NO preference. Reserving it would leave the world nothing: on a 64,000
   * plan it resolves to 64,000, the budget computes to zero, and every
   * triggered entry is dropped. Only a deliberate number reserves room.
   */
  storyMemorySource: "chosen" | "new-account-default" | "carried-over";
  /** World setting, percent of the window. Defaults to all of it. */
  budgetPercent?: number;
  /** World setting, absolute ceiling. 0 or absent = none. */
  budgetCap?: number;
  /**
   * false = legacy behaviour, the budget ignores story memory entirely.
   * Lets the change ship dark and be reverted without a deploy.
   */
  reserveStoryMemory: boolean;
}

/**
 * Tokens the matcher may spend on triggered entries.
 *
 * The creator's own setting still wins when it is the smaller one: an author
 * who capped their lorebook at 8,000 meant it, and reserving story memory
 * must never hand them MORE room than they asked for.
 */
export function resolveLorebookBudget(input: LorebookBudgetInput): number {
  const percent = input.budgetPercent ?? 100;
  let budget = Math.round((percent * input.maxContext) / 100);
  if (input.budgetCap && input.budgetCap > 0) budget = Math.min(budget, input.budgetCap);

  // A carried-over value is the whole window; reserving it starves the world.
  if (input.reserveStoryMemory && input.storyMemorySource !== "carried-over") {
    const room = input.maxContext - input.outputReserve - input.storyMemory;
    budget = Math.min(budget, room);
  }

  return Math.max(MIN_LOREBOOK_BUDGET, Math.floor(budget));
}
