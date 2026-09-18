import assert from "node:assert/strict";
import test from "node:test";
import { getAvatarInitial, getAvatarInitials } from "./avatar-initials.js";

test("emoji display names produce a complete avatar glyph", () => {
  assert.equal(getAvatarInitial("🐕"), "🐕");
  assert.equal(getAvatarInitial("👨‍👩‍👧‍👦 Family"), "👨‍👩‍👧‍👦");
  assert.equal(getAvatarInitial("🇯🇵 user"), "🇯🇵");
});

test("profile initials preserve normal names and fallbacks", () => {
  assert.equal(getAvatarInitials("Georg Sun"), "GS");
  assert.equal(getAvatarInitials("  🐕  "), "🐕");
  assert.equal(getAvatarInitials(""), "?");
});
