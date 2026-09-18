import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SOCIAL_EVENT_RULES,
  SOCIAL_EVENT_REWARD_TIERS,
  SOCIAL_EVENT_VERIFIED_FINAL_FLOOR_MUSHIES,
  calculateEventSettlement,
  calculatePlatformScore,
  calculateVerifiedSettlementFloorMushies,
  createSocialEntrySchema,
  deriveEventPhase,
  socialEventRulesConfigSchema,
  tierForPlatformScore,
} from "../dist/index.js";

test("the V3 score is the plain sum of likes, favorites and valid comments", () => {
  assert.equal(calculatePlatformScore({
    likes: 60,
    favorites: 10,
    validComments: 15,
    shares: 5,
  }), 85);
});

test("shares never change the score but are still validated", () => {
  const base = { likes: 60, favorites: 10, validComments: 15 };
  assert.equal(
    calculatePlatformScore({ ...base, shares: 0 }),
    calculatePlatformScore({ ...base, shares: 9_999 }),
  );
  assert.throws(() => calculatePlatformScore({ ...base, shares: -1 }), /between 0/);
});

test("all V3 reward boundaries map to the cumulative platform tier", () => {
  const expectations = [
    [0, 1_000, null],
    [29, 1_000, null],
    [30, 2_000, null],
    [99, 2_000, null],
    [100, 4_000, null],
    [199, 4_000, null],
    [200, 5_000, "go"],
    [499, 5_000, "go"],
    [500, 7_000, "plus"],
    [999, 7_000, "plus"],
    [1_000, 10_000, "pro"],
    [1_999, 10_000, "pro"],
    [2_000, 15_000, "ultra"],
  ];
  for (const [score, mushies, plan] of expectations) {
    const tier = tierForPlatformScore(score);
    assert.equal(tier.mushies, mushies, `score ${score}`);
    assert.equal(tier.membershipPlanId, plan, `score ${score}`);
  }
  assert.equal(SOCIAL_EVENT_REWARD_TIERS.length, 7);
});

test("two platforms settle independently and only the highest membership is returned", () => {
  const result = calculateEventSettlement([
    {
      entryId: "a",
      platform: "weibo",
      metrics: { likes: 700, favorites: 0, validComments: 0, shares: 0 },
    },
    {
      entryId: "b",
      platform: "youtube",
      metrics: { likes: 50, favorites: 0, validComments: 0, shares: 0 },
    },
  ], 2_000);
  assert.equal(result.totalEntitlement, 9_000);
  assert.equal(result.finalDueMushies, 7_000);
  assert.equal(result.highestPlanId, "plus");
  assert.equal(result.membershipDurationDays, 30);
});

test("five max-tier platforms cap at 75000 and one ultra entitlement", () => {
  const platforms = ["weibo", "youtube", "reddit", "x", "bilibili"];
  const result = calculateEventSettlement(platforms.map((platform, index) => ({
    entryId: String(index),
    platform,
    metrics: { likes: 3_000, favorites: 0, validComments: 0, shares: 0 },
  })), 5_000);
  assert.equal(result.totalEntitlement, 75_000);
  assert.equal(result.finalDueMushies, 70_000);
  assert.equal(result.highestPlanId, "ultra");
});

test("ineligible platforms contribute nothing to entitlement or membership", () => {
  const result = calculateEventSettlement([
    {
      entryId: "a",
      platform: "weibo",
      metrics: { likes: 3_000, favorites: 0, validComments: 0, shares: 0 },
      eligible: false,
    },
    {
      entryId: "b",
      platform: "youtube",
      metrics: { likes: 30, favorites: 0, validComments: 0, shares: 0 },
    },
  ], 0);
  assert.equal(result.totalEntitlement, 2_000);
  assert.equal(result.highestPlanId, null);
  assert.equal(result.platforms.length, 1);
  assert.equal(result.platforms[0].entryId, "b");
});

test("over-committed grants clamp the final due amount to zero", () => {
  const result = calculateEventSettlement([{
    entryId: "a",
    platform: "weibo",
    metrics: { likes: 0, favorites: 0, validComments: 0, shares: 0 },
  }], 5_000);
  assert.equal(result.totalEntitlement, 1_000);
  assert.equal(result.finalDueMushies, 0);
});

test("verified settlement floor guarantees a 1000 Mushies final payment per user", () => {
  assert.equal(SOCIAL_EVENT_VERIFIED_FINAL_FLOOR_MUSHIES, 1_000);
  assert.equal(calculateVerifiedSettlementFloorMushies(0, true), 1_000);
  assert.equal(calculateVerifiedSettlementFloorMushies(400, true), 600);
  assert.equal(calculateVerifiedSettlementFloorMushies(1_000, true), 0);
  assert.equal(calculateVerifiedSettlementFloorMushies(3_000, true), 0);
});

test("settlement floor requires a verified accessible post", () => {
  assert.equal(calculateVerifiedSettlementFloorMushies(0, false), 0);
  assert.throws(() => calculateVerifiedSettlementFloorMushies(-1, true), /non-negative/);
});

test("pending, processing, failed and applied grants are all committed", () => {
  const result = calculateEventSettlement([{
    entryId: "a",
    platform: "weibo",
    metrics: { likes: 700, favorites: 0, validComments: 0, shares: 0 },
  }], [
    { kind: "mushies", amount: 1_000, status: "pending" },
    { kind: "mushies", amount: 1_000, status: "processing" },
    { kind: "mushies", amount: 1_000, status: "failed" },
    { kind: "mushies", amount: 1_000, status: "applied" },
    { kind: "mushies", amount: 1_000, status: "cancelled" },
    { kind: "mushies", amount: 1_000, status: "reversed" },
  ]);
  assert.equal(result.committedEventMushies, 4_000);
  assert.equal(result.finalDueMushies, 3_000);
});

test("settlement rejects a sixth platform and duplicate platform", () => {
  const entry = (platform, index) => ({
    entryId: String(index),
    platform,
    metrics: { likes: 0, favorites: 0, validComments: 0, shares: 0 },
  });
  assert.throws(() => calculateEventSettlement([
    "weibo", "youtube", "reddit", "x", "bilibili", "instagram",
  ].map(entry), 0), /at most 5/);
  assert.throws(() => calculateEventSettlement([
    entry("weibo", 1), entry("weibo", 2),
  ], 0), /Duplicate platform/);
});

test("metric validation and score helpers reject invalid numbers", () => {
  assert.throws(() => calculatePlatformScore({
    likes: -1,
    favorites: 0,
    validComments: 0,
    shares: 0,
  }), /between 0/);
  assert.throws(() => calculatePlatformScore({
    likes: 100_000_001,
    favorites: 0,
    validComments: 0,
    shares: 0,
  }), /100000000/);
  assert.throws(() => tierForPlatformScore(1.5), /safe integer/);
});

test("event phase uses half-open windows and reports overdue rewards", () => {
  const timeline = {
    registrationOpensAt: "2026-07-15T16:00:00.000Z",
    registrationClosesAt: "2026-08-18T16:00:00.000Z",
    finalDataOpensAt: "2026-08-18T16:00:00.000Z",
    finalDataClosesAt: "2026-08-21T16:00:00.000Z",
    settlementDeadlineAt: "2026-08-28T16:00:00.000Z",
  };
  assert.equal(deriveEventPhase("2026-07-01T00:00:00.000Z", timeline), "upcoming");
  assert.equal(deriveEventPhase(timeline.registrationOpensAt, timeline), "registration_open");
  assert.equal(deriveEventPhase(timeline.finalDataOpensAt, timeline), "final_data_open");
  assert.equal(deriveEventPhase(timeline.finalDataClosesAt, timeline), "official_verification");
  assert.equal(deriveEventPhase(timeline.settlementDeadlineAt, timeline), "overdue");
  assert.equal(deriveEventPhase(timeline.settlementDeadlineAt, timeline, "completed"), "completed");
});

test("shared Zod contracts enforce private evidence and fixed V3 rules", () => {
  assert.equal(socialEventRulesConfigSchema.parse(DEFAULT_SOCIAL_EVENT_RULES).maxPlatformsPerUser, 5);
  assert.equal(createSocialEntrySchema.safeParse({
    platform: "weibo",
    socialHandle: "yumina",
    postUrl: "https://weibo.com/1/abc",
    initialEvidenceIds: [],
  }).success, false);
  assert.equal(socialEventRulesConfigSchema.safeParse({
    ...DEFAULT_SOCIAL_EVENT_RULES,
    rewardTiers: DEFAULT_SOCIAL_EVENT_RULES.rewardTiers.map((tier, index) => (
      index === 0 ? { ...tier, mushies: 15_000, membershipPlanId: "ultra" } : tier
    )),
  }).success, false);
});
