import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasInternalBackEntry,
  navigateBackSafely,
  parseSafeInternalFallback,
  type InternalBackHistory,
} from "./safe-back.js";

function createHistory(index: number | undefined, canGoBack = true) {
  const calls = { back: 0, replace: [] as string[] };
  const history: InternalBackHistory = {
    location: { state: { __TSR_index: index } },
    canGoBack: () => canGoBack,
    back: () => { calls.back += 1; },
    replace: (path) => { calls.replace.push(path); },
  };
  return { history, calls };
}

test("uses Back only for a proven router-owned entry", () => {
  const internal = createHistory(3);
  assert.equal(hasInternalBackEntry(internal.history), true);
  navigateBackSafely(internal.history, "/app/library");
  assert.equal(internal.calls.back, 1);
  assert.deepEqual(internal.calls.replace, []);
});

test("direct links replace with their canonical internal parent", () => {
  for (const index of [0, undefined]) {
    const direct = createHistory(index);
    navigateBackSafely(direct.history, "/app/library?view=favorites#saved");
    assert.equal(direct.calls.back, 0);
    assert.deepEqual(direct.calls.replace, ["/app/library?view=favorites#saved"]);
  }
});

test("does not trust a positive index when the router cannot go back", () => {
  const unavailable = createHistory(2, false);
  navigateBackSafely(unavailable.history, "/content");
  assert.deepEqual(unavailable.calls.replace, ["/content"]);
});

test("rejects external, ambiguous, and API fallbacks", () => {
  const unsafe = [
    "https://evil.example/app/library",
    "//evil.example/app/library",
    "/\\evil.example/app/library",
    "javascript:alert(1)",
    "app/library",
    "/api/worlds",
    "",
    null,
  ];

  for (const value of unsafe) {
    assert.equal(parseSafeInternalFallback(value), undefined, String(value));
  }

  const fallback = createHistory(0);
  navigateBackSafely(fallback.history, "https://evil.example/");
  assert.deepEqual(fallback.calls.replace, ["/app/hub"]);
});
