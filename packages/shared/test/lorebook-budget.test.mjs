import assert from "node:assert/strict";
import test from "node:test";
import { resolveLorebookBudget } from "../dist/index.js";

const base = {
  maxContext: 64_000,
  outputReserve: 4_000,
  storyMemory: 16_000,
  storyMemorySource: "chosen",
  reserveStoryMemory: true,
};

test("the flag off reproduces the old number exactly", () => {
  // Ships dark: with the env unset the budget is what it has always been,
  // the full window, so no prompt changes on deploy.
  assert.equal(resolveLorebookBudget({ ...base, reserveStoryMemory: false }), 64_000);
});

test("the flag on holds back the conversation and the reply", () => {
  assert.equal(resolveLorebookBudget(base), 64_000 - 4_000 - 16_000);
});

test("the case this exists for: a big world on a small plan", () => {
  // 55,000 world, 64,000 cap. Before, the world took what it liked and the
  // player's 16,000 became 9,000. Now the world is trimmed to 44,000 and the
  // conversation keeps every token it was promised.
  const budget = resolveLorebookBudget(base);
  assert.ok(budget < 55_000, "a 55k world must now be trimmed");
  assert.equal(base.maxContext - base.outputReserve - budget, 16_000);
});

test("a small world is unaffected, because it never reaches the budget", () => {
  // The budget is a ceiling, not an allocation: an 8k world spends 8k.
  assert.ok(resolveLorebookBudget(base) > 8_000);
});

test("the creator's own cap still wins when it is smaller", () => {
  // An author who capped their lorebook at 8,000 meant it. Reserving story
  // memory must never hand them more room than they asked for.
  assert.equal(resolveLorebookBudget({ ...base, budgetCap: 8_000 }), 8_000);
});

test("the creator's percentage still wins when it is smaller", () => {
  assert.equal(resolveLorebookBudget({ ...base, budgetPercent: 25 }), 16_000);
});

test("an absurd story memory starves triggered lore rather than going negative", () => {
  // The player asked for 60,000 of conversation inside a 64,000 cap. Dropping
  // contextual lore is the honest consequence; a negative budget is a crash.
  const budget = resolveLorebookBudget({ ...base, storyMemory: 60_000 });
  assert.equal(budget, 0);
});

test("never returns a negative budget", () => {
  assert.equal(resolveLorebookBudget({ ...base, storyMemory: 200_000 }), 0);
  assert.equal(resolveLorebookBudget({ ...base, outputReserve: 100_000 }), 0);
});

test("a roomy plan leaves the world essentially untouched", () => {
  // Platinum and up: 200,000 window, so reserving 16,000 changes nothing a
  // real world would notice.
  const budget = resolveLorebookBudget({ ...base, maxContext: 200_000 });
  assert.equal(budget, 180_000);
});

test("percent and cap and reservation compose, smallest wins", () => {
  const budget = resolveLorebookBudget({ ...base, budgetPercent: 50, budgetCap: 40_000 });
  // 50% of 64,000 = 32,000; cap 40,000; reservation leaves 44,000. Smallest.
  assert.equal(budget, 32_000);
});

test("a carried-over value never reserves, or it would starve the world", () => {
  // The bug caught before shipping. An account that never chose resolves to
  // its whole window, so reserving it computes a zero budget and drops every
  // triggered entry. Absence of a preference is not a reservation.
  const budget = resolveLorebookBudget({
    ...base,
    storyMemory: 64_000,
    storyMemorySource: "carried-over",
  });
  assert.equal(budget, 64_000, "an existing account must see the legacy budget");
});

test("a new account's default does reserve, because it is a real choice we made", () => {
  const budget = resolveLorebookBudget({ ...base, storyMemorySource: "new-account-default" });
  assert.equal(budget, 64_000 - 4_000 - 16_000);
});
