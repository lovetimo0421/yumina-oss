/**
 * The story memory a turn actually runs with, as the AI settings slider shows
 * it: the player's own choice, else the account's default, never above the
 * overall limit in force (the plan's cap for official API users, 200,000 at
 * most) or the overall context setting. One function so the slider and the
 * Memory panel's "≈ the latest N messages" never disagree.
 */
export function effectiveStoryMemory(args: {
  storyMemory: number | null | undefined;
  maxContext: number;
  memoryCap: number | null | undefined;
  provider: string | null | undefined;
  defaultStoryMemory: number | null | undefined;
}): { value: number; ceiling: number } {
  const capped = args.provider !== "private" && typeof args.memoryCap === "number" && args.memoryCap > 0;
  const ceiling = Math.min(capped ? args.memoryCap! : 2_000_000, 200_000);
  const value = args.storyMemory ?? Math.min(args.maxContext, args.defaultStoryMemory ?? ceiling);
  return { value: Math.min(value, ceiling, args.maxContext), ceiling };
}
