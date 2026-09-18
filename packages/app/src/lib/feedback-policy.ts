/**
 * Pure rules for the feedback pill. No DOM, no Sonner — so it can be unit-tested
 * and so the policy lives in one place. Spec:
 * docs/superpowers/specs/2026-09-05-feedback-system-redesign-design.md §4.
 */
export type FeedbackKind = "notice" | "error" | "undo" | "progress" | "persistent";
export type ProgressOutcome = "done" | "failed";

export const FEEDBACK_MAX_CHARS = 80;

export const FEEDBACK_DURATION_MS = {
  notice: 2500,
  error: 6000,
  undo: 5000,
  progressPending: Infinity,
  progressDone: 2500,
  progressFailed: 6000,
  persistent: Infinity,
} as const;

export function durationFor(kind: FeedbackKind, settled?: ProgressOutcome): number {
  switch (kind) {
    case "notice":
      return FEEDBACK_DURATION_MS.notice;
    case "error":
      return FEEDBACK_DURATION_MS.error;
    case "undo":
      return FEEDBACK_DURATION_MS.undo;
    case "persistent":
      return FEEDBACK_DURATION_MS.persistent;
    case "progress":
      if (settled === "done") return FEEDBACK_DURATION_MS.progressDone;
      if (settled === "failed") return FEEDBACK_DURATION_MS.progressFailed;
      return FEEDBACK_DURATION_MS.progressPending;
  }
}

export type FeedbackTextViolation = "empty" | "newline" | "length" | "exclamation" | "successfully";

/**
 * Flatten dynamic text (server errors, world-authored notifications, i18n copy
 * with long interpolations) to one pill line: whitespace collapsed, first
 * sentence when the whole thing is too long, clamped to the cap with an
 * ellipsis, trailing "!" dropped. Authored copy should not need this.
 */
export function toPillText(raw: unknown, max = FEEDBACK_MAX_CHARS): string {
  const flat = String(raw ?? "").replace(/\s+/g, " ").trim();
  const firstSentence = flat.length > max ? (/^.*?[.!?。！？]/.exec(flat)?.[0] ?? flat) : flat;
  const clamped = firstSentence.length > max ? `${firstSentence.slice(0, max - 1)}…` : firstSentence;
  return clamped.replace(/[!！]+$/, "");
}

/** Returns the first rule the copy breaks, or null when it is acceptable pill copy. */
export function validateFeedbackText(text: string): FeedbackTextViolation | null {
  if (text.trim().length === 0) return "empty";
  if (/[\r\n]/.test(text)) return "newline";
  if (text.length > FEEDBACK_MAX_CHARS) return "length";
  if (/!\s*$/.test(text)) return "exclamation";
  if (/successfully/i.test(text)) return "successfully";
  return null;
}
