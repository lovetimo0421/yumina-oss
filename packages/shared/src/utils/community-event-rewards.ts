import type {
  SocialCommittedMushiesGrant,
  SocialEventPhase,
  SocialEventRulesConfig,
  SocialEventTimeline,
  SocialMembershipPlanId,
  SocialMetrics,
  SocialRewardTier,
  SocialSettlementInput,
  SocialSettlementState,
  SocialSettlementSummary,
} from "../types/community-event.js";

export const SOCIAL_EVENT_INITIAL_MUSHIES = 1_000;
export const SOCIAL_EVENT_VERIFIED_FINAL_FLOOR_MUSHIES = 1_000;
export const SOCIAL_EVENT_VERIFIED_FINAL_FLOOR_RULES_VERSION = 2;
export const SOCIAL_EVENT_MAX_PLATFORMS = 5;
export const SOCIAL_EVENT_MAX_MUSHIES = 75_000;
export const SOCIAL_EVENT_MEMBERSHIP_DURATION_DAYS = 30;
// Keep each value and the unweighted sum inside PostgreSQL INTEGER.
export const SOCIAL_EVENT_MAX_METRIC_VALUE = 100_000_000;

// V3 final (2026-07-16): score = likes + favorites + validComments (no
// multipliers, shares not counted). Thresholds were lowered ~1/3 from the
// draft ×2-weighted ladder to keep tier difficulty roughly equivalent.
export const SOCIAL_EVENT_REWARD_TIERS: readonly SocialRewardTier[] = [
  { minScore: 0, maxScore: 29, mushies: 1_000, membershipPlanId: null },
  { minScore: 30, maxScore: 99, mushies: 2_000, membershipPlanId: null },
  { minScore: 100, maxScore: 199, mushies: 4_000, membershipPlanId: null },
  { minScore: 200, maxScore: 499, mushies: 5_000, membershipPlanId: "go" },
  { minScore: 500, maxScore: 999, mushies: 7_000, membershipPlanId: "plus" },
  { minScore: 1_000, maxScore: 1_999, mushies: 10_000, membershipPlanId: "pro" },
  { minScore: 2_000, maxScore: null, mushies: 15_000, membershipPlanId: "ultra" },
] as const;

export const DEFAULT_SOCIAL_EVENT_RULES: SocialEventRulesConfig = {
  allowedPlatforms: [
    "xiaohongshu",
    "douyin",
    "weibo",
    "bilibili",
    "kuaishou",
    "tiktok",
    "instagram",
    "youtube",
    "x",
    "threads",
    "reddit",
  ],
  maxPlatformsPerUser: SOCIAL_EVENT_MAX_PLATFORMS,
  initialMushiesPerPlatform: SOCIAL_EVENT_INITIAL_MUSHIES,
  membershipDurationDays: SOCIAL_EVENT_MEMBERSHIP_DURATION_DAYS,
  scoreWeights: { likes: 1, favorites: 1, validComments: 1, shares: 0 },
  rewardTiers: SOCIAL_EVENT_REWARD_TIERS.map((tier) => ({ ...tier })),
  unlimitedParticipants: true,
  evidenceRetentionDays: 90,
  grantMonthlyCreditsOnActivation: true,
};

function assertMetric(value: number, name: keyof SocialMetrics): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > SOCIAL_EVENT_MAX_METRIC_VALUE) {
    throw new RangeError(`${name} must be an integer between 0 and ${SOCIAL_EVENT_MAX_METRIC_VALUE}`);
  }
  return value;
}

export function calculatePlatformScore(metrics: SocialMetrics): number {
  const likes = assertMetric(metrics.likes, "likes");
  const favorites = assertMetric(metrics.favorites, "favorites");
  const validComments = assertMetric(metrics.validComments, "validComments");
  // Shares are still recorded as evidence but do not count toward the score.
  assertMetric(metrics.shares, "shares");
  const score = likes + favorites + validComments;
  if (!Number.isSafeInteger(score)) {
    throw new RangeError("Platform score exceeds the safe integer range");
  }
  return score;
}

export function tierForPlatformScore(score: number): SocialRewardTier {
  if (!Number.isSafeInteger(score) || score < 0) {
    throw new RangeError("score must be a non-negative safe integer");
  }
  return SOCIAL_EVENT_REWARD_TIERS.find(
    (tier) => score >= tier.minScore && (tier.maxScore === null || score <= tier.maxScore),
  )!;
}

const PLAN_RANK: Record<SocialMembershipPlanId, number> = {
  go: 1,
  plus: 2,
  pro: 3,
  ultra: 4,
};

function committedMushies(
  grants: number | readonly SocialCommittedMushiesGrant[],
): number {
  if (typeof grants === "number") {
    if (!Number.isSafeInteger(grants) || grants < 0) {
      throw new RangeError("committedEventMushies must be a non-negative safe integer");
    }
    return grants;
  }
  return grants.reduce((total, grant) => {
    if (!Number.isSafeInteger(grant.amount) || grant.amount < 0) {
      throw new RangeError("grant amount must be a non-negative safe integer");
    }
    return ["pending", "processing", "failed", "applied"].includes(grant.status)
      ? total + grant.amount
      : total;
  }, 0);
}

export function calculateEventSettlement(
  entries: readonly SocialSettlementInput[],
  committedGrants: number | readonly SocialCommittedMushiesGrant[],
): SocialSettlementSummary {
  if (entries.length > SOCIAL_EVENT_MAX_PLATFORMS) {
    throw new RangeError(`An event settlement supports at most ${SOCIAL_EVENT_MAX_PLATFORMS} platforms`);
  }
  const seenPlatforms = new Set<string>();
  const platforms = entries.filter((entry) => entry.eligible !== false).map((entry) => {
    if (seenPlatforms.has(entry.platform)) {
      throw new Error(`Duplicate platform in settlement: ${entry.platform}`);
    }
    seenPlatforms.add(entry.platform);
    const score = calculatePlatformScore(entry.metrics);
    const tier = tierForPlatformScore(score);
    return {
      entryId: entry.entryId,
      platform: entry.platform,
      score,
      mushies: tier.mushies,
      membershipPlanId: tier.membershipPlanId,
    };
  });

  const totalEntitlement = platforms.reduce((total, platform) => total + platform.mushies, 0);
  if (totalEntitlement > SOCIAL_EVENT_MAX_MUSHIES) {
    throw new RangeError("Settlement exceeds the event Mushies cap");
  }
  const committedEventMushies = committedMushies(committedGrants);
  const highestPlanId = platforms.reduce<SocialMembershipPlanId | null>((highest, platform) => {
    const candidate = platform.membershipPlanId;
    if (!candidate) return highest;
    if (!highest || PLAN_RANK[candidate] > PLAN_RANK[highest]) return candidate;
    return highest;
  }, null);

  return {
    platforms,
    totalEntitlement,
    committedEventMushies,
    finalDueMushies: Math.max(totalEntitlement - committedEventMushies, 0),
    highestPlanId,
    membershipDurationDays: highestPlanId ? SOCIAL_EVENT_MEMBERSHIP_DURATION_DAYS : 0,
  };
}

/**
 * A verified participant should see a real wallet credit during final review.
 * This is deliberately separate from the score-tier entitlement: callers must
 * gate it on the event rules version and on an admin-verified accessible post.
 */
export function calculateVerifiedSettlementFloorMushies(
  finalDueMushies: number,
  hasVerifiedAccessiblePost: boolean,
): number {
  if (!Number.isSafeInteger(finalDueMushies) || finalDueMushies < 0) {
    throw new RangeError("finalDueMushies must be a non-negative safe integer");
  }
  if (!hasVerifiedAccessiblePost) return 0;
  return Math.max(SOCIAL_EVENT_VERIFIED_FINAL_FLOOR_MUSHIES - finalDueMushies, 0);
}

function timestamp(value: string | Date): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) throw new RangeError("Invalid event timeline date");
  return result;
}

export function deriveEventPhase(
  now: string | number | Date,
  timeline: SocialEventTimeline,
  settlementState: SocialSettlementState = "not_started",
): SocialEventPhase {
  const current = typeof now === "number" ? now : timestamp(now);
  if (!Number.isFinite(current)) throw new RangeError("Invalid current date");
  const registrationOpensAt = timestamp(timeline.registrationOpensAt);
  const registrationClosesAt = timestamp(timeline.registrationClosesAt);
  const finalDataOpensAt = timestamp(timeline.finalDataOpensAt);
  const finalDataClosesAt = timestamp(timeline.finalDataClosesAt);
  const settlementDeadlineAt = timestamp(timeline.settlementDeadlineAt);

  if (!(registrationOpensAt <= registrationClosesAt
      && registrationClosesAt <= finalDataOpensAt
      && finalDataOpensAt <= finalDataClosesAt
      && finalDataClosesAt <= settlementDeadlineAt)) {
    throw new RangeError("Event timeline must be chronological");
  }
  if (settlementState === "completed") return "completed";
  if (current < registrationOpensAt) return "upcoming";
  if (current < registrationClosesAt) return "registration_open";
  if (current >= finalDataOpensAt && current < finalDataClosesAt) return "final_data_open";
  if (current < settlementDeadlineAt) return "official_verification";
  return "overdue";
}
