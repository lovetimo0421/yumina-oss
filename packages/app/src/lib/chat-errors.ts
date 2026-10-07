import i18n from "@/lib/i18n";
import { classifyChatError, errorDetail } from "../../sandbox/chat/error-codes";

// Provider safety-filter refusals arrive as raw English text and are by far
// the most common in-chat generation error on a catalog that is mostly
// NSFW / real-person roleplay. Known shapes:
//   - ours:        "Response blocked by safety/content filter. Try regenerating…"
//   - Gemini/OR:   "Gemini blocked the request: PROHIBITED_CONTENT"
//   - OpenAI-ish:  finish_reason "content_filter", moderation errors
//   - Alibaba:     "Output data may contain inappropriate content"
// Deliberately narrower than the server-side retry pattern: a match REPLACES
// the error text the user sees, so bare words like "safety" or "flagged"
// (which can appear in non-refusal provider errors) must not match here.
const CONTENT_BLOCK_PATTERN =
  /prohibited[_\s-]?content|content[_\s-]?filter|blocked by safety|safety filter|content moderation|inappropriate content|flagged as/i;

export function isContentBlockedError(message: string | null | undefined): boolean {
  return !!message && CONTENT_BLOCK_PATTERN.test(message);
}

/**
 * Localize a server/provider error for the chat's error banner.
 *
 * The server's `code` wins; raw-text patterns cover the rest (the shared
 * classifier in sandbox/chat/error-codes.ts, which the in-frame failed-turn
 * row uses too). Anything unrecognized becomes a generic localized line that
 * keeps the raw detail for support — the banner used to show the raw English
 * on its own ("No API key configured for this provider. Add one in
 * Settings.") to players in every language.
 */
export function localizeChatError(message: string, code?: string | null): string {
  const known = classifyChatError(message, code);
  for (const key of [known, code]) {
    // `code` covers the ones this build has its own copy for (SUSPENDED,
    // PROTECTED_WORLD, …) that are not player-actionable categories.
    if (key && i18n.exists(`errors.${key}`, { ns: "chat" })) {
      return i18n.t(`errors.${key}` as never, { ns: "chat" }) as string;
    }
  }
  const detail = errorDetail(message);
  return detail
    ? i18n.t("errors.GENERIC_WITH_DETAIL", { ns: "chat", detail, defaultValue: message })
    : i18n.t("errors.GENERATION_FAILED", { ns: "chat", defaultValue: "The AI response failed. Please try again." });
}
