import assert from "node:assert/strict";
import test from "node:test";
import { resolveStoryMemory } from "@yumina/shared";

const old = new Date("2026-09-04T00:00:00Z");
const from = new Date("2026-09-22T11:34:00Z");

test("an explicit choice beats the carried-over default", () => {
  assert.deepEqual(
    resolveStoryMemory({ saved: 90000, maxContext: 200000, accountCreatedAt: old, newAccountsFrom: from, carriedOverDefault: 32000 }),
    { tokens: 90000, source: "chosen" },
  );
});

test("carried-over default applies under the plan ceiling, unset keeps the whole window", () => {
  assert.deepEqual(
    resolveStoryMemory({ maxContext: 200000, accountCreatedAt: old, newAccountsFrom: from, carriedOverDefault: 32000 }),
    { tokens: 32000, source: "carried-over-default" },
  );
  assert.deepEqual(
    resolveStoryMemory({ maxContext: 24000, accountCreatedAt: old, newAccountsFrom: from, carriedOverDefault: 32000 }),
    { tokens: 24000, source: "carried-over-default" },
  );
  assert.deepEqual(
    resolveStoryMemory({ maxContext: 64000, accountCreatedAt: old, newAccountsFrom: from }),
    { tokens: 64000, source: "carried-over" },
  );
});

test("new accounts keep their own default", () => {
  assert.deepEqual(
    resolveStoryMemory({ maxContext: 64000, accountCreatedAt: new Date("2026-10-01T00:00:00Z"), newAccountsFrom: from, carriedOverDefault: 32000 }),
    { tokens: 16000, source: "new-account-default" },
  );
});
