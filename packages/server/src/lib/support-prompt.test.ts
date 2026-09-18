import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_WORLD_DOWNLOADS,
  MIN_WORLD_INTERACTIONS,
  SUPPORT_PROMPT_THRESHOLD,
  scoreSupportPrompt,
  worldMeetsTractionFloor,
  type SupportPromptInputs,
} from "./support-prompt.js";

// A player well past every target: 2h, 90 turns, 6 days, their top world.
const DEEP: SupportPromptInputs = {
  playtimeSeconds: 7_200,
  turnCount: 90,
  dayCount: 6,
  worldRank: 1,
  worldsPlayed: 12,
};

function withInputs(patch: Partial<SupportPromptInputs>): SupportPromptInputs {
  return { ...DEEP, ...patch };
}

test("a deep, returning player on their favourite world is eligible", () => {
  const result = scoreSupportPrompt(DEEP);
  assert.equal(result.eligible, true);
  assert.ok(result.score >= SUPPORT_PROMPT_THRESHOLD, `score ${result.score}`);
  assert.ok(result.score <= 1);
});

test("score is capped at 1 no matter how far past the targets a player goes", () => {
  const result = scoreSupportPrompt(withInputs({
    playtimeSeconds: 400_000,
    turnCount: 5_000,
    dayCount: 300,
  }));
  assert.ok(result.score <= 1, `score ${result.score}`);
});

// The geometric mean is the whole point: idling with the tab open must not
// earn a prompt, and neither must a burst of turns in two minutes.
test("hours of playtime with zero turns scores zero", () => {
  const result = scoreSupportPrompt(withInputs({ playtimeSeconds: 36_000, turnCount: 0 }));
  assert.equal(result.depth, 0);
  assert.equal(result.eligible, false);
});

test("many turns with no real playtime scores zero", () => {
  const result = scoreSupportPrompt(withInputs({ playtimeSeconds: 0, turnCount: 300 }));
  assert.equal(result.depth, 0);
  assert.equal(result.eligible, false);
});

test("a single-day binge still qualifies, just discounted", () => {
  const oneDay = scoreSupportPrompt(withInputs({ dayCount: 1 }));
  const manyDays = scoreSupportPrompt(withInputs({ dayCount: 6 }));
  assert.equal(oneDay.eligible, true);
  assert.ok(oneDay.score < manyDays.score, "returning should always outscore a single session");
});

test("the absolute floor rejects a short session even at a perfect ratio", () => {
  // 19 minutes, 14 turns — proportionally healthy, but below the floor.
  const result = scoreSupportPrompt(withInputs({
    playtimeSeconds: 19 * 60,
    turnCount: 14,
    dayCount: 3,
  }));
  assert.equal(result.meetsFloor, false);
  assert.equal(result.eligible, false);
});

test("the floor is inclusive at exactly 20 minutes and 15 turns", () => {
  const result = scoreSupportPrompt(withInputs({ playtimeSeconds: 20 * 60, turnCount: 15 }));
  assert.equal(result.meetsFloor, true);
});

test("a world outside the player's top tier is discounted, not disqualified", () => {
  const favourite = scoreSupportPrompt(withInputs({ worldRank: 1 }));
  const alsoRan = scoreSupportPrompt(withInputs({ worldRank: 40, worldsPlayed: 60 }));
  assert.equal(favourite.affinity, 1);
  assert.ok(alsoRan.affinity < 1);
  assert.ok(alsoRan.score < favourite.score);
});

test("top three counts as a favourite even for players with a huge library", () => {
  const result = scoreSupportPrompt(withInputs({ worldRank: 3, worldsPlayed: 500 }));
  assert.equal(result.affinity, 1);
});

test("top 20% counts as a favourite even when the rank number is large", () => {
  const result = scoreSupportPrompt(withInputs({ worldRank: 10, worldsPlayed: 50 }));
  assert.equal(result.affinity, 1);
});

test("a player's only world is their favourite", () => {
  const result = scoreSupportPrompt(withInputs({ worldRank: 1, worldsPlayed: 1 }));
  assert.equal(result.affinity, 1);
});

test("negative or absurd inputs cannot produce a score above the threshold", () => {
  for (const bad of [
    { playtimeSeconds: -100 },
    { turnCount: -5 },
    { dayCount: -1 },
    { playtimeSeconds: Number.NaN },
    { turnCount: Number.NaN },
    { worldRank: 0 },
    { worldsPlayed: 0 },
  ] as Array<Partial<SupportPromptInputs>>) {
    const result = scoreSupportPrompt(withInputs(bad));
    assert.ok(Number.isFinite(result.score), `score not finite for ${JSON.stringify(bad)}`);
    assert.ok(result.score >= 0 && result.score <= 1, `score out of range for ${JSON.stringify(bad)}`);
  }
});

// ─── World traction floor ───────────────────────────────────────────
// A card with no audience should never trigger the prompt, however deeply one
// player happens to play it.

test("a world at exactly the traction floor qualifies", () => {
  assert.equal(MIN_WORLD_DOWNLOADS, 100);
  assert.equal(MIN_WORLD_INTERACTIONS, 20);
  assert.equal(worldMeetsTractionFloor(100, 10, 10), true);
});

test("one download short of the floor disqualifies, whatever the interactions", () => {
  assert.equal(worldMeetsTractionFloor(99, 500, 500), false);
});

test("one interaction short of the floor disqualifies, whatever the downloads", () => {
  assert.equal(worldMeetsTractionFloor(10_000, 19, 0), false);
});

test("favourites and reviews pool together into the interaction count", () => {
  assert.equal(worldMeetsTractionFloor(100, 20, 0), true);
  assert.equal(worldMeetsTractionFloor(100, 0, 20), true);
  assert.equal(worldMeetsTractionFloor(100, 12, 8), true);
});

test("negative or non-finite counts collapse to zero instead of poisoning the check", () => {
  assert.equal(worldMeetsTractionFloor(Number.NaN, 20, 20), false);
  assert.equal(worldMeetsTractionFloor(-100, 20, 20), false);
  assert.equal(worldMeetsTractionFloor(100, Number.NaN, 19), false);
  // A corrupt favourite count zeroes out; genuine reviews still carry the floor.
  assert.equal(worldMeetsTractionFloor(100, -5, 20), true);
});

test("the threshold sits where a genuinely borderline session lands", () => {
  // 45 min / 40 turns / 2 days on a favourite world — the shape of a player
  // who is clearly invested but has not made it a habit yet.
  const borderline = scoreSupportPrompt(withInputs({
    playtimeSeconds: 45 * 60,
    turnCount: 40,
    dayCount: 2,
  }));
  assert.equal(borderline.eligible, true);

  // Half of each target on a non-favourite world must not qualify.
  const thin = scoreSupportPrompt(withInputs({
    playtimeSeconds: 22 * 60,
    turnCount: 20,
    dayCount: 1,
    worldRank: 30,
    worldsPlayed: 60,
  }));
  assert.equal(thin.eligible, false);
});
