import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampComposerMessage,
  getComposerMessageLimitState,
  MAX_USER_MESSAGE_CHARS,
} from "./composer-message-limit";

describe("composer message limit", () => {
  it("uses the fifteen-thousand-character composer limit", () => {
    assert.equal(MAX_USER_MESSAGE_CHARS, 15_000);
  });

  it("keeps a message exactly at the server limit", () => {
    const message = "a".repeat(MAX_USER_MESSAGE_CHARS);

    assert.equal(clampComposerMessage(message), message);
  });

  it("truncates text beyond the server limit", () => {
    const message = "a".repeat(MAX_USER_MESSAGE_CHARS + 1);

    assert.equal(clampComposerMessage(message).length, MAX_USER_MESSAGE_CHARS);
  });

  it("does not split an emoji at the UTF-16 boundary", () => {
    const message = `${"a".repeat(MAX_USER_MESSAGE_CHARS - 1)}😀`;
    const clamped = clampComposerMessage(message);

    assert.equal(clamped, "a".repeat(MAX_USER_MESSAGE_CHARS - 1));
    assert.equal(clamped.length, MAX_USER_MESSAGE_CHARS - 1);
  });

  it("keeps the maximum whole-emoji message", () => {
    const message = "😀".repeat(MAX_USER_MESSAGE_CHARS / 2 + 1);
    const clamped = clampComposerMessage(message);

    assert.equal(clamped, "😀".repeat(MAX_USER_MESSAGE_CHARS / 2));
    assert.equal(clamped.length, MAX_USER_MESSAGE_CHARS);
  });

  it("shows a warning only above ninety percent and marks the exact limit", () => {
    assert.equal(
      getComposerMessageLimitState("a".repeat(MAX_USER_MESSAGE_CHARS * 0.9 - 1)),
      "hidden",
    );
    assert.equal(
      getComposerMessageLimitState("a".repeat(MAX_USER_MESSAGE_CHARS * 0.9)),
      "hidden",
    );
    assert.equal(
      getComposerMessageLimitState("a".repeat(MAX_USER_MESSAGE_CHARS * 0.9 + 1)),
      "warning",
    );
    assert.equal(
      getComposerMessageLimitState("a".repeat(MAX_USER_MESSAGE_CHARS)),
      "limit",
    );
  });
});
