/**
 * One classifier for every chat failure a player can see: the send/regenerate
 * error banner (host store, localized with i18next) and the failed-turn row
 * stored on the server (rendered inside the sandbox with its own string
 * table). Both used to print the server/provider's raw English
 * ("No API key configured for this provider. Add one in Settings.") to every
 * player regardless of language.
 *
 * A server `code` always wins. Raw-text patterns cover servers/providers that
 * send none; they are deliberately specific — an unrecognized error returns
 * null and the caller shows a generic localized line with the raw detail,
 * never a confident wrong explanation.
 *
 * Pure and dependency-free so the host (src/lib/chat-errors.ts) can import it
 * across the sandbox boundary, like slim-messages.ts does.
 */

export type ChatErrorCode =
  | "NO_API_KEY"
  | "MODEL_UNAVAILABLE"
  | "NO_CREDITS"
  | "RATE_LIMITED"
  | "CONTEXT_TOO_LONG"
  | "UPSTREAM_BUSY"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "CONNECTION_LOST"
  | "OFFLINE"
  | "SERVER_RESTART"
  | "EMPTY_REPLY"
  | "CONTENT_BLOCKED"
  | "FREE_POOL_EXHAUSTED";

/** Server codes that name the same situation as one of ours. */
const SERVER_CODE_ALIASES: Record<string, ChatErrorCode> = {
  NO_API_KEY: "NO_API_KEY",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  NO_CREDITS: "NO_CREDITS",
  RATE_LIMITED: "RATE_LIMITED",
  CONTEXT_TOO_LONG: "CONTEXT_TOO_LONG",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_BUSY",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  INTERRUPTED: "CONNECTION_LOST",
  CONNECTION_FAILED: "CONNECTION_LOST",
  CONNECTION_UNCERTAIN: "CONNECTION_LOST",
  OFFLINE: "OFFLINE",
  SERVER_RESTART: "SERVER_RESTART",
  EMPTY_REPLY: "EMPTY_REPLY",
  CONTENT_FILTER: "CONTENT_BLOCKED",
  CONTENT_BLOCKED: "CONTENT_BLOCKED",
  FREE_POOL_EXHAUSTED: "FREE_POOL_EXHAUSTED",
};

// Order matters: the more specific situations are checked first.
const PATTERNS: ReadonlyArray<readonly [RegExp, ChatErrorCode]> = [
  [/no api key configured/i, "NO_API_KEY"],
  [/free-models-per-day|hit its daily limit upstream/i, "FREE_POOL_EXHAUSTED"],
  [/prohibited[_\s-]?content|content[_\s-]?filter|blocked by safety|safety filter|content moderation|inappropriate content|flagged as/i, "CONTENT_BLOCKED"],
  [/context (length|window)|maximum context|context_length_exceeded|too many tokens|prompt is too long|reduce the length of the (messages|prompt)|input is too long/i, "CONTEXT_TOO_LONG"],
  [/you'?re offline|browser is offline|internet disconnected|ERR_INTERNET_DISCONNECTED/i, "OFFLINE"],
  [/server is restarting/i, "SERVER_RESTART"],
  [/model returned an empty reply/i, "EMPTY_REPLY"],
  [/model is unavailable|model .{0,60}(is )?not available|no endpoints found|model not found|is not a valid model/i, "MODEL_UNAVAILABLE"],
  [/not enough mushies|used all your credits|insufficient (credits|balance)/i, "NO_CREDITS"],
  [/connection lost|connection closed unexpectedly|stream read failed|failed to fetch|load failed|networkerror|network request failed|connection to the server failed|no response body/i, "CONNECTION_LOST"],
  [/timed? ?out|timeout|\b524\b|\b504\b|stopped responding/i, "UPSTREAM_TIMEOUT"],
  [/rate.?limit|\b429\b|temporarily|failed upstream|overloaded|provider (is )?busy|provider returned error|\b50[023]\b|html error page|upstream error/i, "UPSTREAM_BUSY"],
];

export function classifyChatError(
  message: string | null | undefined,
  code?: string | null,
): ChatErrorCode | null {
  if (code && SERVER_CODE_ALIASES[code]) return SERVER_CODE_ALIASES[code]!;
  const text = message ?? "";
  if (!text) return null;
  for (const [pattern, mapped] of PATTERNS) {
    if (pattern.test(text)) return mapped;
  }
  // A bare "HTTP 5xx: …" from an unknown upstream is still "the service is
  // having trouble", not something the player did.
  if (/^HTTP 5\d\d\b/.test(text)) return "UPSTREAM_BUSY";
  return null;
}

/** Raw detail kept behind a generic localized line: short, one line. */
export function errorDetail(message: string | null | undefined, max = 140): string {
  const flat = (message ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
