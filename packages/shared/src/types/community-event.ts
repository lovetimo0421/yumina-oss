export const EVENT_SUBMISSION_TYPES = ["world", "social_post"] as const;
export type EventSubmissionType = (typeof EVENT_SUBMISSION_TYPES)[number];

export const SOCIAL_PLATFORMS = [
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
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const FINAL_DATA_MODES = ["user_evidence", "official_link_check"] as const;
export type FinalDataMode = (typeof FINAL_DATA_MODES)[number];

export const METRIC_RESOLUTIONS = [
  "user_evidence",
  "official_link_check",
  "unverifiable",
] as const;
export type MetricResolution = (typeof METRIC_RESOLUTIONS)[number];

export const SOCIAL_ENTRY_STATUSES = [
  "draft",
  "submitted",
  "under_initial_review",
  "needs_changes",
  "initial_approved",
  "initial_rejected",
  "under_final_review",
  "settled",
  "disqualified",
] as const;
export type SocialEntryStatus = (typeof SOCIAL_ENTRY_STATUSES)[number];

export const SOCIAL_EVENT_PHASES = [
  "upcoming",
  "registration_open",
  "final_data_open",
  "official_verification",
  "completed",
  "overdue",
] as const;
export type SocialEventPhase = (typeof SOCIAL_EVENT_PHASES)[number];

export const SOCIAL_MEMBERSHIP_PLAN_IDS = ["go", "plus", "pro", "ultra"] as const;
export type SocialMembershipPlanId = (typeof SOCIAL_MEMBERSHIP_PLAN_IDS)[number];

export interface SocialMetrics {
  likes: number;
  favorites: number;
  validComments: number;
  shares: number;
}

export interface SocialScoreWeights {
  likes: number;
  favorites: number;
  validComments: number;
  shares: number;
}

export interface SocialRewardTier {
  minScore: number;
  maxScore: number | null;
  mushies: number;
  membershipPlanId: SocialMembershipPlanId | null;
}

export interface SocialEventRulesConfig {
  allowedPlatforms: SocialPlatform[];
  maxPlatformsPerUser: number;
  initialMushiesPerPlatform: number;
  membershipDurationDays: number;
  scoreWeights: SocialScoreWeights;
  rewardTiers: SocialRewardTier[];
  unlimitedParticipants: true;
  evidenceRetentionDays: number;
  grantMonthlyCreditsOnActivation: boolean;
}

export interface SocialEventTimeline {
  registrationOpensAt: string | Date;
  registrationClosesAt: string | Date;
  finalDataOpensAt: string | Date;
  finalDataClosesAt: string | Date;
  settlementDeadlineAt: string | Date;
}

export type SocialSettlementState =
  | "not_started"
  | "calculating"
  | "reward_pending"
  | "completed";

export interface SocialSettlementInput {
  entryId: string;
  platform: SocialPlatform;
  metrics: SocialMetrics;
  /** False excludes a rejected/disqualified platform from all entitlements. */
  eligible?: boolean;
}

export const COMMITTED_REWARD_GRANT_STATUSES = [
  "pending",
  "processing",
  "failed",
  "applied",
] as const;
export type CommittedRewardGrantStatus = (typeof COMMITTED_REWARD_GRANT_STATUSES)[number];

export interface SocialCommittedMushiesGrant {
  kind: "mushies";
  amount: number;
  status: CommittedRewardGrantStatus | "cancelled" | "reversed";
}

export interface SocialPlatformSettlement {
  entryId: string;
  platform: SocialPlatform;
  score: number;
  mushies: number;
  membershipPlanId: SocialMembershipPlanId | null;
}

export interface SocialSettlementSummary {
  platforms: SocialPlatformSettlement[];
  totalEntitlement: number;
  committedEventMushies: number;
  finalDueMushies: number;
  highestPlanId: SocialMembershipPlanId | null;
  membershipDurationDays: number;
}

export interface WorldEventSubmissionInput {
  submissionType: "world";
  worldId: string;
}

export interface SocialEventSubmissionInput {
  submissionType: "social_post";
  platform: SocialPlatform;
  socialHandle: string;
  postUrl: string;
  postPublishedAt?: string;
  initialEvidenceIds: string[];
}

export type CommunityEventSubmissionInput =
  | WorldEventSubmissionInput
  | SocialEventSubmissionInput;

export interface SocialEventEntry {
  id: string;
  eventId: string;
  userId: string;
  platform: SocialPlatform;
  socialHandle: string;
  status: SocialEntryStatus;
  finalDataMode: FinalDataMode | null;
  verifiedScore: number | null;
  platformEntitlement: number | null;
  membershipPlanId: SocialMembershipPlanId | null;
}

export interface SocialEntryRevision {
  id: string;
  entryId: string;
  revisionNo: number;
  changeKind: "initial" | "correction" | "replacement";
  postUrl: string;
  canonicalUrl: string;
  canonicalPostKey: string;
  postPublishedAt: string;
  submittedAt: string;
  rulesVersion: number;
}

export interface SocialMetricSnapshot {
  id: string;
  entryId: string;
  resolution: MetricResolution;
  metrics: SocialMetrics;
  score: number;
  mushies: number;
  membershipPlanId: SocialMembershipPlanId | null;
  verifiedAt: string;
}
