export const DISPLAY_MODE_CONFIRM_TIMEOUT_MS = 10_000;

export type DisplayModeConfirmationStep = "choose" | "confirm";

/**
 * A false value is a real windowed-mode choice, not an empty value. Keeping
 * this distinction in one place prevents windowed selections from skipping
 * the confirmation step through a truthiness check.
 */
export function getDisplayModeConfirmationStep(
  pendingChoice: boolean | null,
): DisplayModeConfirmationStep {
  return pendingChoice === null ? "choose" : "confirm";
}

/** Whole seconds shown in the display-mode confirmation countdown. */
export function getDisplayModeSecondsRemaining(deadlineMs: number, nowMs = Date.now()) {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
}
