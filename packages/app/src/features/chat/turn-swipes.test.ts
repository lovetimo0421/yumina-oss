import assert from "node:assert/strict";
import test from "node:test";
import { appendRegenSwipe, type TurnSwipe } from "./turn-swipes";

const swipe = (over: Partial<TurnSwipe> = {}): TurnSwipe => ({
  content: "regen body",
  rawContent: "raw regen body [hp: add 5]",
  createdAt: "2026-08-03T00:00:10.000Z",
  model: "some/model",
  ...over,
});

// Regression: before swipe-mirroring, regenerate only bumped activeSwipeIndex
// so the counter read "2/1" and swipes[activeSwipeIndex] was undefined (the
// "view raw" toggle vanished until a page refresh).
test("appendRegenSwipe appends the new swipe and points the active index at it", () => {
  const prior: TurnSwipe[] = [
    { content: "first", rawContent: "raw first", createdAt: "2026-08-03T00:00:00.000Z" },
  ];
  const { swipes, activeSwipeIndex } = appendRegenSwipe(prior, swipe(), {
    serverSwipeIndex: 1,
    serverTotal: 2,
    padCreatedAt: "2026-08-03T00:00:00.000Z",
  });
  assert.equal(swipes.length, 2);
  assert.equal(activeSwipeIndex, 1);
  assert.equal(swipes[activeSwipeIndex]!.rawContent, "raw regen body [hp: add 5]");
  // Prior swipes untouched
  assert.equal(swipes[0]!.content, "first");
});

test("appendRegenSwipe pads with placeholders when the local array lags the server count", () => {
  // Message sent from a tab opened before mirroring shipped: no local swipes,
  // but the server already holds 2 and just appended a 3rd.
  const { swipes, activeSwipeIndex } = appendRegenSwipe(undefined, swipe(), {
    serverSwipeIndex: 2,
    serverTotal: 3,
    padCreatedAt: "2026-08-03T00:00:00.000Z",
  });
  assert.equal(swipes.length, 3);
  assert.equal(activeSwipeIndex, 2);
  assert.equal(swipes[2]!.content, "regen body");
  // Placeholders are inert — non-active swipe content is refetched on swipe.
  assert.equal(swipes[0]!.content, "");
  assert.equal(swipes[1]!.content, "");
});

test("appendRegenSwipe falls back to last index without server metadata", () => {
  const { swipes, activeSwipeIndex } = appendRegenSwipe(
    [swipe({ content: "old" })],
    swipe(),
    { padCreatedAt: "2026-08-03T00:00:00.000Z" },
  );
  assert.equal(swipes.length, 2);
  assert.equal(activeSwipeIndex, 1);
});

test("appendRegenSwipe clamps a server index that points past the local array", () => {
  const { swipes, activeSwipeIndex } = appendRegenSwipe(
    [swipe({ content: "old" })],
    swipe(),
    { serverSwipeIndex: 5, padCreatedAt: "2026-08-03T00:00:00.000Z" },
  );
  // Active index must always be addressable locally — an out-of-range index
  // is exactly the bug this module exists to prevent.
  assert.equal(activeSwipeIndex, swipes.length - 1);
});
