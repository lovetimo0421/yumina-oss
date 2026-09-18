import i18n from "@/lib/i18n";

// Provider safety-filter refusals arrive as raw English text and are by far
// the most common in-chat generation error on a catalog that is mostly
// NSFW / real-person roleplay. Known shapes:
//   - ours:        "Response blocked by safety/content filter. Try regenerating…"
//   - Gemini/OR:   "Gemini blocked the request: PROHIBITED_CONTENT"
//   - OpenAI-ish:  finish_reason "content_filter", moderation errors
//   - Alibaba:     "Output data may contain inappropriate content"
// Mirrors the sandbox-side classifier in packages/app/sandbox/chat/i18n.ts —
// the sandbox iframe can't import host modules, so keep the patterns in sync.
// Deliberately narrower than the server-side retry pattern: a match REPLACES
// the error text the user sees, so bare words like "safety" or "flagged"
// (which can appear in non-refusal provider errors) must not match here.
const CONTENT_BLOCK_PATTERN =
  /prohibited[_\s-]?content|content[_\s-]?filter|blocked by safety|safety filter|content moderation|inappropriate content|flagged as/i;

export function isContentBlockedError(message: string | null | undefined): boolean {
  return !!message && CONTENT_BLOCK_PATTERN.test(message);
}

/**
 * Localize a raw provider/server error line for chat display. Recognized
 * categories map to a translated explanation; anything else passes through
 * unchanged (better a raw English line than a wrong translation).
 */
export function localizeChatError(message: string): string {
  if (isContentBlockedError(message)) {
    return i18n.t("errors.CONTENT_BLOCKED", { ns: "chat", defaultValue: message });
  }
  return message;
}
