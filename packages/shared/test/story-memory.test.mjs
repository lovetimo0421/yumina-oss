import assert from "node:assert/strict";
import test from "node:test";
import { resolveStoryMemory, SUGGESTED_STORY_MEMORY } from "../dist/index.js";

const LAUNCH = new Date("2026-10-01T00:00:00Z");
const BEFORE = new Date("2026-09-01T00:00:00Z");
const AFTER = new Date("2026-10-02T00:00:00Z");

test("an account that never chose keeps what it already had", () => {
  // The whole point of the flag: deploying must not cut anyone's prompts.
  const r = resolveStoryMemory({ maxContext: 200_000, accountCreatedAt: BEFORE, newAccountsFrom: LAUNCH });
  assert.equal(r.tokens, 200_000);
  assert.equal(r.source, "carried-over");
});

test("an account created after the flag instant starts at the suggestion", () => {
  const r = resolveStoryMemory({ maxContext: 200_000, accountCreatedAt: AFTER, newAccountsFrom: LAUNCH });
  assert.equal(r.tokens, SUGGESTED_STORY_MEMORY);
  assert.equal(r.source, "new-account-default");
});

test("with the flag unset nobody is moved, however new the account", () => {
  // Ships dark: merging to main changes no prompt until the env is set.
  const r = resolveStoryMemory({ maxContext: 200_000, accountCreatedAt: AFTER, newAccountsFrom: null });
  assert.equal(r.tokens, 200_000);
  assert.equal(r.source, "carried-over");
});

test("an explicit choice wins on any account, flag or no flag", () => {
  // This is what makes the announcement actionable before the flip.
  const old = resolveStoryMemory({ saved: 16_000, maxContext: 200_000, accountCreatedAt: BEFORE, newAccountsFrom: null });
  assert.equal(old.tokens, 16_000);
  assert.equal(old.source, "chosen");
});

test("the overall ceiling still wins over a bigger choice", () => {
  // A Free account clamped to 64,000 cannot buy its way past the plan cap.
  const r = resolveStoryMemory({ saved: 200_000, maxContext: 64_000, accountCreatedAt: BEFORE, newAccountsFrom: LAUNCH });
  assert.equal(r.tokens, 64_000);
});

test("a new account under a small cap gets the cap, not the suggestion", () => {
  const r = resolveStoryMemory({ maxContext: 8_000, accountCreatedAt: AFTER, newAccountsFrom: LAUNCH });
  assert.equal(r.tokens, 8_000);
});

test("junk values fall through to the carried-over reading", () => {
  for (const saved of [0, -1, Number.NaN, null, undefined]) {
    const r = resolveStoryMemory({ saved, maxContext: 96_000, accountCreatedAt: BEFORE, newAccountsFrom: LAUNCH });
    assert.equal(r.tokens, 96_000, `saved=${String(saved)}`);
  }
});

test("an account created exactly at the instant counts as new", () => {
  const r = resolveStoryMemory({ maxContext: 200_000, accountCreatedAt: LAUNCH, newAccountsFrom: LAUNCH });
  assert.equal(r.source, "new-account-default");
});

test("a missing creation date is treated as existing, never as new", () => {
  const r = resolveStoryMemory({ maxContext: 200_000, accountCreatedAt: null, newAccountsFrom: LAUNCH });
  assert.equal(r.source, "carried-over");
});
