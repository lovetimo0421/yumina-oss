import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSafeInternalReturnUrl,
  parseStoryReturnKey,
} from "./story-return-url.js";

test("accepts internal return URLs with page state", () => {
  assert.equal(
    parseSafeInternalReturnUrl("/app/hub?tab=following&q=magic#results"),
    "/app/hub?tab=following&q=magic#results",
  );
  assert.equal(parseSafeInternalReturnUrl("/app/library"), "/app/library");
  assert.equal(parseSafeInternalReturnUrl("/notifications"), "/notifications");
});

test("rejects external and ambiguous return URLs", () => {
  const unsafe = [
    "https://evil.example/app/library",
    "//evil.example/app/library",
    "/\\evil.example/app/library",
    "javascript:alert(1)",
    "app/library",
    "/login?next=/app/library",
    "/api/worlds",
    "",
    null,
  ];

  for (const value of unsafe) {
    assert.equal(parseSafeInternalReturnUrl(value), undefined, String(value));
  }
});

test("accepts only generated-looking return context keys", () => {
  assert.equal(parseStoryReturnKey("3b10e4ec-4672-4e7a-90da-27489cbd2d0d"), "3b10e4ec-4672-4e7a-90da-27489cbd2d0d");
  assert.equal(parseStoryReturnKey("short"), undefined);
  assert.equal(parseStoryReturnKey("../../escape-context"), undefined);
});
