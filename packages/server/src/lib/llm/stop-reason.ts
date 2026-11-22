/**
 * Finish reasons that mean a policy layer stopped the reply (Gemini SAFETY /
 * PROHIBITED_CONTENT, OpenAI-style content_filter, and the rest). Shared by
 * every provider so a stop reads the same whichever road the reply took.
 */
const CONTENT_FILTER_FINISH_REASONS = new Set([
  "safety", "content_filter", "prohibited_content", "blocklist", "spii",
  "image_safety", "image_prohibited_content",
]);

export function isContentFilterFinishReason(fr: string | null | undefined): boolean {
  return !!fr && CONTENT_FILTER_FINISH_REASONS.has(fr.toLowerCase());
}

/** A provider's finish reason as the story routes read it: "max_tokens" for a
 *  length stop, "content_filter" for a policy stop, otherwise as given. */
export function normalizeStopReason(fr: string | null | undefined): string | undefined {
  if (!fr) return undefined;
  if (fr === "length" || fr === "MAX_TOKENS" || fr === "max_tokens") return "max_tokens";
  if (isContentFilterFinishReason(fr)) return "content_filter";
  return fr;
}

/** Why a saved reply ended before the model finished: it hit the reply length
 *  limit, or the model's provider stopped it partway for its content. */
export type ReplyCut = "length" | "filter";

export function replyCutOf(stopReason: string | undefined): ReplyCut | undefined {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "content_filter" || stopReason === "SAFETY") return "filter";
  return undefined;
}
