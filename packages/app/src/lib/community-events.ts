import {
  getAssetUploadErrorMessage,
  uploadAssetWithPresignedUrl,
} from "@/lib/asset-upload";
import type {
  EventSubmissionType,
  FinalDataMode,
  SocialEntryStatus,
  SocialEventPhase,
  SocialEventRulesConfig,
  SocialMetrics,
  SocialPlatform,
} from "@yumina/shared";

export type {
  EventSubmissionType,
  FinalDataMode,
  SocialEntryStatus,
  SocialEventPhase,
  SocialEventRulesConfig,
  SocialMetrics,
  SocialPlatform,
} from "@yumina/shared";

const apiBase = import.meta.env.VITE_API_URL || "";

export type EventStatus = "draft" | "live" | "closed";
export type EventSubmissionStatus = "pending" | "needs_changes" | "finished";
export type EventRewardType = "mushies" | "plan" | "combo" | null;
export type SocialFinalDataMode = FinalDataMode | null;
export type CommunityEventPhase = SocialEventPhase;
export type SocialEventMetrics = SocialMetrics;

export interface CommunityEvent {
  id: string;
  title: string;
  introduction: string;
  rewardDescription: string | null;
  lang: string;
  submissionType: EventSubmissionType;
  singleSubmissionPerUser: boolean;
  status: EventStatus;
  isCached: boolean;
  cachedAt: string | null;
  promoteInCommunity: boolean;
  promoteInDiscover: boolean;
  bannerImageUrl: string | null;
  posterImageUrl: string | null;
  registrationOpensAt?: string | null;
  registrationClosesAt?: string | null;
  finalDataOpensAt?: string | null;
  finalDataClosesAt?: string | null;
  settlementDeadlineAt?: string | null;
  phase?: CommunityEventPhase;
  rulesVersion?: number | null;
  rulesConfig?: SocialEventRulesConfig | null;
  rulesLockedAt?: string | null;
  announcementThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  totalSubmissionCount: number;
  pendingReviewCount?: number;
  pendingSubmissionCount?: number;
  needsChangesSubmissionCount?: number;
  finishedSubmissionCount?: number;
  createdByAdminId?: string | null;
  createdByAdminName?: string | null;
  updatedByAdminId?: string | null;
  updatedByAdminName?: string | null;
  translatedTitle_zh?: string | null;
  translatedIntroduction_zh?: string | null;
  translatedTitle_en?: string | null;
  translatedIntroduction_en?: string | null;
  translatedTitle_es?: string | null;
  translatedIntroduction_es?: string | null;
  translatedTitle_ja?: string | null;
  translatedIntroduction_ja?: string | null;
}

export interface SocialEventEvidence {
  id: string;
  filename?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  status: "uploading" | "ready" | "attached" | "rejected" | "deleted";
  purpose?: "initial" | "final_metrics" | "additional";
  createdAt?: string;
}

export interface SocialEventEntry {
  id: string;
  eventId: string;
  userId?: string;
  platform: SocialPlatform;
  socialHandle: string;
  draftPayload?: {
    socialHandle?: string;
    postUrl?: string;
    postPublishedAt?: string;
    initialEvidenceIds?: string[];
  } | null;
  postUrl: string | null;
  postRawUrl?: string | null;
  riskFlags?: string[];
  submitterName?: string | null;
  submitterImage?: string | null;
  postPublishedAt: string | null;
  status: SocialEntryStatus;
  revisionNo?: number;
  replacementCount?: number;
  initialReviewEligibleAt?: string | null;
  initialRewardGranted?: boolean;
  initialRewardAmount?: number;
  finalDataMode?: SocialFinalDataMode;
  submittedMetrics?: SocialEventMetrics | null;
  verifiedMetrics?: SocialEventMetrics | null;
  evidence?: SocialEventEvidence[];
  adminComment?: string | null;
  verifiedScore?: number | null;
  platformEntitlement?: number | null;
  membershipPlanId?: string | null;
  currentRevision?: unknown;
  latestMetricSnapshot?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SocialEventSettlement {
  id?: string;
  status: "draft" | "pending" | "processing" | "completed" | "failed" | "cancelled";
  totalEntitlement: number;
  committedMushies: number;
  finalDueMushies: number;
  calculatedFloorTopUp?: number;
  calculatedFinalPayoutMushies?: number;
  appliedPerformanceTopUpMushies?: number;
  appliedFloorTopUp?: number;
  appliedFinalPayoutMushies?: number;
  floorGrantStatus?: string | null;
  verifiedPostCount?: number;
  highestPlanId: string | null;
  membershipDurationDays?: number | null;
  updatedAt?: string;
}

export interface SocialEventParticipation {
  eventId: string;
  phase?: CommunityEventPhase;
  entries: SocialEventEntry[];
  settlement?: SocialEventSettlement | null;
  rulesConfig?: SocialEventRulesConfig;
  timeline?: {
    registrationOpensAt: string;
    registrationClosesAt: string;
    finalDataOpensAt: string;
    finalDataClosesAt: string;
    settlementDeadlineAt: string;
  };
  limits?: {
    maxPlatformsPerUser: number;
    initialMushiesPerPlatform: number;
    maxTotalMushies: number;
  };
  rewardGrants?: unknown[];
}

export interface CommunityEventSubmission {
  id: string;
  eventId: string;
  submitterId: string;
  submitterName?: string | null;
  submitterImage?: string | null;
  worldId: string;
  worldName: string;
  worldDescription: string | null;
  worldThumbnailUrl: string | null;
  status: EventSubmissionStatus;
  adminComment: string | null;
  rewardType: EventRewardType;
  rewardAmount: number | null;
  rewardPlanId: string | null;
  rewardDurationDays: number | null;
  reviewerAdminId: string | null;
  reviewerAdminName: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EventImageAssetResponse {
  id: string;
  url: string;
  key: string;
}

async function uploadEventImage(file: File): Promise<{ previewUrl: string; rawKey: string }> {
  const asset = await uploadAssetWithPresignedUrl<EventImageAssetResponse>({
    file,
    preferredType: "image",
    resizeImageMaxDimension: 2048,
    prepareUrl: `${apiBase}/api/user-assets/upload-url`,
    registerUrl: `${apiBase}/api/user-assets`,
    registerBody: ({ key, resolvedType, contentType }) => ({
      key,
      filename: file.name,
      type: resolvedType,
      mimeType: contentType,
      sizeBytes: file.size,
    }),
  });

  return {
    previewUrl: asset.url,
    rawKey: asset.key,
  };
}

export function uploadEventBanner(file: File): Promise<{ previewUrl: string; rawKey: string }> {
  return uploadEventImage(file);
}

export function uploadEventPoster(file: File): Promise<{ previewUrl: string; rawKey: string }> {
  return uploadEventImage(file);
}

export function getEventUploadErrorMessage(error: unknown): string {
  return getAssetUploadErrorMessage(error);
}
