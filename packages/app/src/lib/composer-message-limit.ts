import { MAX_USER_MESSAGE_CHARS } from "@yumina/shared";

export { MAX_USER_MESSAGE_CHARS };

export type ComposerMessageLimitState = "hidden" | "warning" | "limit";

export function getComposerMessageLimitState(value: string): ComposerMessageLimitState {
  if (value.length >= MAX_USER_MESSAGE_CHARS) return "limit";
  if (value.length > MAX_USER_MESSAGE_CHARS * 0.9) return "warning";
  return "hidden";
}

/**
 * Keep composer text within the same UTF-16 code-unit limit enforced by the
 * message route. Avoid leaving a dangling high surrogate when an emoji lands
 * across the boundary.
 */
export function clampComposerMessage(value: string): string {
  if (value.length <= MAX_USER_MESSAGE_CHARS) return value;

  const clamped = value.slice(0, MAX_USER_MESSAGE_CHARS);
  const lastCodeUnit = clamped.charCodeAt(clamped.length - 1);
  const endsWithHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;

  return endsWithHighSurrogate ? clamped.slice(0, -1) : clamped;
}
