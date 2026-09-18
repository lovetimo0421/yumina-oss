export const VERIFIED_SETTLEMENT_FLOOR_PURPOSE = "verified_settlement_floor" as const;

export type ReviewedSocialSnapshot = {
  id: string;
  entryId: string;
  reviewerAdminId: string | null;
  resolution: string;
  linkStatus: string;
  verifiedAt: Date | string;
  createdAt: Date | string;
};

export type SettlementPayoutGrant = {
  id?: string;
  phase: string;
  purpose: string | null;
  kind: string;
  amount: number | null;
  status: string;
};

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function isVerifiedAccessibleSnapshot(snapshot: ReviewedSocialSnapshot): boolean {
  return snapshot.reviewerAdminId !== null
    && snapshot.resolution === "official_link_check"
    && snapshot.linkStatus === "accessible";
}

/** Select exactly one latest admin-reviewed snapshot per entry. */
export function latestAdminReviewedSnapshots<T extends ReviewedSocialSnapshot>(
  snapshots: readonly T[],
): Map<string, T> {
  const ordered = snapshots
    .filter((snapshot) => snapshot.reviewerAdminId !== null)
    .slice()
    .sort((left, right) => (
      timestamp(right.verifiedAt) - timestamp(left.verifiedAt)
      || timestamp(right.createdAt) - timestamp(left.createdAt)
      || right.id.localeCompare(left.id)
    ));
  const latest = new Map<string, T>();
  for (const snapshot of ordered) {
    if (!latest.has(snapshot.entryId)) latest.set(snapshot.entryId, snapshot);
  }
  return latest;
}

export function summarizeSettlementPayouts(input: {
  grants: readonly SettlementPayoutGrant[];
  calculatedPerformanceTopUpMushies: number;
  calculatedFloorTopUp: number;
}) {
  const floorGrants = input.grants.filter((grant) => (
    grant.kind === "mushies" && grant.purpose === VERIFIED_SETTLEMENT_FLOOR_PURPOSE
  ));
  const appliedPerformanceTopUpMushies = input.grants
    .filter((grant) => (
      grant.kind === "mushies"
      && grant.phase !== "initial"
      && grant.purpose !== VERIFIED_SETTLEMENT_FLOOR_PURPOSE
      && grant.status === "applied"
    ))
    .reduce((sum, grant) => sum + (grant.amount ?? 0), 0);
  const appliedFloorTopUp = floorGrants
    .filter((grant) => grant.status === "applied")
    .reduce((sum, grant) => sum + (grant.amount ?? 0), 0);
  const floorGrantStatus = floorGrants.length === 0
    ? null
    : floorGrants.some((grant) => grant.status === "failed")
      ? "failed"
      : floorGrants.some((grant) => grant.status === "processing")
        ? "processing"
        : floorGrants.some((grant) => grant.status === "pending")
          ? "pending"
          : floorGrants.every((grant) => grant.status === "applied")
            ? "applied"
            : floorGrants[0]!.status;

  return {
    calculatedFloorTopUp: input.calculatedFloorTopUp,
    calculatedFinalPayoutMushies:
      input.calculatedPerformanceTopUpMushies + input.calculatedFloorTopUp,
    appliedPerformanceTopUpMushies,
    appliedFloorTopUp,
    appliedFinalPayoutMushies: appliedPerformanceTopUpMushies + appliedFloorTopUp,
    floorGrantStatus,
  };
}

export function verifiedSettlementFloorGrantKey(input: {
  eventId: string;
  userId: string;
  rulesVersion?: number;
  backfillVersion?: number;
}): string {
  if (input.backfillVersion !== undefined) {
    return `event:${input.eventId}:user:${input.userId}:verified-settlement-floor:backfill-v${input.backfillVersion}:mushies`;
  }
  if (input.rulesVersion === undefined) throw new Error("VERIFIED_SETTLEMENT_FLOOR_RULES_VERSION_REQUIRED");
  return `event:${input.eventId}:user:${input.userId}:verified-settlement-floor:rules-v${input.rulesVersion}:mushies`;
}

export function assertVerifiedSettlementFloorGrantMatches(
  grant: {
    eventId: string;
    userId: string;
    settlementId: string | null;
    purpose: string | null;
    kind: string;
    phase: string;
    amount: number | null;
  },
  expected: {
    eventId: string;
    userId: string;
    settlementId: string;
    amount: number;
  },
): void {
  if (
    grant.eventId !== expected.eventId
    || grant.userId !== expected.userId
    || grant.settlementId !== expected.settlementId
    || grant.purpose !== VERIFIED_SETTLEMENT_FLOOR_PURPOSE
    || grant.kind !== "mushies"
    || grant.phase !== "adjustment"
    || grant.amount !== expected.amount
  ) {
    throw new Error("SOCIAL_SETTLEMENT_FLOOR_GRANT_CONFLICT");
  }
}

export function verifiedSettlementFloorNotification(input: {
  eventId: string;
  settlementId: string;
  grantId: string;
  amount: number;
  verifiedPostCount: number;
}) {
  if (!input.eventId || !input.settlementId || !input.grantId) {
    throw new Error("VERIFIED_SETTLEMENT_FLOOR_NOTIFICATION_IDS_REQUIRED");
  }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new Error("VERIFIED_SETTLEMENT_FLOOR_NOTIFICATION_AMOUNT_INVALID");
  }
  if (!Number.isSafeInteger(input.verifiedPostCount) || input.verifiedPostCount <= 0) {
    throw new Error("VERIFIED_SETTLEMENT_FLOOR_NOTIFICATION_AUDIT_INVALID");
  }
  const dedupeKey = `verified-settlement-floor:${input.grantId}`;
  return {
    dedupeKey,
    payload: {
      eventId: input.eventId,
      settlementId: input.settlementId,
      grantId: input.grantId,
      amount: input.amount,
      verifiedPostCount: input.verifiedPostCount,
      rewardStatus: "verified_floor_applied",
      dedupeKey,
      i18nKey: "community.events.social.settlement.verifiedFloorApplied",
    },
  } as const;
}
