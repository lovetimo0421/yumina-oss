import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DISPLAY_MODE_CONFIRM_TIMEOUT_MS,
  getDisplayModeConfirmationStep,
  getDisplayModeSecondsRemaining,
} from "./display-mode-confirmation";

describe("display mode confirmation step", () => {
  it("shows the chooser only before a mode is selected", () => {
    assert.equal(getDisplayModeConfirmationStep(null), "choose");
  });

  it("advances both fullscreen and windowed choices to confirmation", () => {
    assert.equal(getDisplayModeConfirmationStep(true), "confirm");
    assert.equal(getDisplayModeConfirmationStep(false), "confirm");
  });
});

describe("display mode confirmation countdown", () => {
  it("starts at ten seconds and rounds partial seconds up", () => {
    const startedAt = 25_000;
    const deadline = startedAt + DISPLAY_MODE_CONFIRM_TIMEOUT_MS;

    assert.equal(getDisplayModeSecondsRemaining(deadline, startedAt), 10);
    assert.equal(getDisplayModeSecondsRemaining(deadline, startedAt + 1), 10);
    assert.equal(getDisplayModeSecondsRemaining(deadline, startedAt + 1_001), 9);
  });

  it("never returns a negative value after the deadline", () => {
    assert.equal(getDisplayModeSecondsRemaining(10_000, 10_000), 0);
    assert.equal(getDisplayModeSecondsRemaining(10_000, 12_500), 0);
  });
});
