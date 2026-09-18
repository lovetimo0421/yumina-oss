import { z } from "zod";
import {
  EVENT_SUBMISSION_TYPES,
  FINAL_DATA_MODES,
  METRIC_RESOLUTIONS,
  SOCIAL_MEMBERSHIP_PLAN_IDS,
  SOCIAL_PLATFORMS,
} from "../types/community-event.js";
import {
  MAX_SOCIAL_EVIDENCE_PER_SUBMISSION,
  MAX_SOCIAL_EVENT_PLATFORMS,
  MAX_SOCIAL_HANDLE_LENGTH,
  MAX_SOCIAL_POST_URL_LENGTH,
} from "../constants/limits.js";
import {
  SOCIAL_EVENT_MAX_METRIC_VALUE,
  SOCIAL_EVENT_REWARD_TIERS,
} from "../utils/community-event-rewards.js";

const metricValueSchema = z.number().int().min(0).max(SOCIAL_EVENT_MAX_METRIC_VALUE);

export const eventSubmissionTypeSchema = z.enum(EVENT_SUBMISSION_TYPES);
export const socialPlatformSchema = z.enum(SOCIAL_PLATFORMS);
export const finalDataModeSchema = z.enum(FINAL_DATA_MODES);
export const metricResolutionSchema = z.enum(METRIC_RESOLUTIONS);

export const socialMetricsSchema = z.object({
  likes: metricValueSchema,
  favorites: metricValueSchema,
  validComments: metricValueSchema,
  shares: metricValueSchema,
}).strict();

const rewardTierSchema = z.object({
  minScore: z.number().int().min(0),
  maxScore: z.number().int().min(0).nullable(),
  mushies: z.number().int().min(0).max(15_000),
  membershipPlanId: z.enum(SOCIAL_MEMBERSHIP_PLAN_IDS).nullable(),
}).strict();

export const socialEventRulesConfigSchema = z.object({
  allowedPlatforms: z.array(socialPlatformSchema)
    .min(1)
    .max(SOCIAL_PLATFORMS.length)
    .refine((values) => new Set(values).size === values.length, "Platforms must be unique"),
  maxPlatformsPerUser: z.number().int().min(1).max(MAX_SOCIAL_EVENT_PLATFORMS),
  initialMushiesPerPlatform: z.literal(1_000),
  membershipDurationDays: z.literal(30),
  scoreWeights: z.object({
    likes: z.literal(1),
    favorites: z.literal(1),
    validComments: z.literal(1),
    shares: z.literal(0),
  }).strict(),
  rewardTiers: z.array(rewardTierSchema).length(7).refine(
    (tiers) => JSON.stringify(tiers) === JSON.stringify(SOCIAL_EVENT_REWARD_TIERS),
    "Reward tiers must match the locked V3 schedule",
  ),
  unlimitedParticipants: z.literal(true),
  evidenceRetentionDays: z.number().int().min(1).max(3650),
  grantMonthlyCreditsOnActivation: z.boolean(),
}).strict();

export const socialEventTimelineSchema = z.object({
  registrationOpensAt: z.string().datetime({ offset: true }),
  registrationClosesAt: z.string().datetime({ offset: true }),
  finalDataOpensAt: z.string().datetime({ offset: true }),
  finalDataClosesAt: z.string().datetime({ offset: true }),
  settlementDeadlineAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, ctx) => {
  const timelineKeys = [
    "registrationOpensAt",
    "registrationClosesAt",
    "finalDataOpensAt",
    "finalDataClosesAt",
    "settlementDeadlineAt",
  ] as const;
  const dates = [
    value.registrationOpensAt,
    value.registrationClosesAt,
    value.finalDataOpensAt,
    value.finalDataClosesAt,
    value.settlementDeadlineAt,
  ].map((date) => Date.parse(date));
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index]! < dates[index - 1]!) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [timelineKeys[index]!],
        message: "Event timeline must be chronological",
      });
    }
  }
});

const evidenceIdsSchema = z.array(z.string().min(1).max(200))
  .min(1)
  .max(MAX_SOCIAL_EVIDENCE_PER_SUBMISSION)
  .refine((values) => new Set(values).size === values.length, "Evidence IDs must be unique");

export const createSocialEntrySchema = z.object({
  submissionType: z.literal("social_post").optional().default("social_post"),
  platform: socialPlatformSchema,
  socialHandle: z.string().trim().min(1).max(MAX_SOCIAL_HANDLE_LENGTH),
  postUrl: z.string().trim().url().max(MAX_SOCIAL_POST_URL_LENGTH),
  postPublishedAt: z.string().datetime({ offset: true }).optional(),
  initialEvidenceIds: evidenceIdsSchema,
}).strict();

export const communityEventSubmissionInputSchema = z.discriminatedUnion("submissionType", [
  z.object({
    submissionType: z.literal("world"),
    worldId: z.string().min(1),
  }).strict(),
  createSocialEntrySchema.omit({ submissionType: true }).extend({
    submissionType: z.literal("social_post"),
  }).strict(),
]);

export type SocialMetricsSchema = z.infer<typeof socialMetricsSchema>;
export type SocialEventRulesConfigSchema = z.infer<typeof socialEventRulesConfigSchema>;
export type SocialEventTimelineSchema = z.infer<typeof socialEventTimelineSchema>;
export type CreateSocialEntrySchema = z.infer<typeof createSocialEntrySchema>;
