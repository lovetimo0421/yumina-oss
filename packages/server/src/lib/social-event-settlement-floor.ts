import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  communityEventRewardGrants,
  communityEventSocialEntries,
  communityEventSocialMetricSnapshots,
  communityEventSocialSettlements,
  notifications,
} from "../db/schema.js";
import { notify } from "./notify.js";
export {
  assertVerifiedSettlementFloorGrantMatches,
  isVerifiedAccessibleSnapshot,
  latestAdminReviewedSnapshots,
  summarizeSettlementPayouts,
  verifiedSettlementFloorNotification,
  verifiedSettlementFloorGrantKey,
  VERIFIED_SETTLEMENT_FLOOR_PURPOSE,
} from "./social-event-settlement-floor-core.js";
import {
  isVerifiedAccessibleSnapshot,
  latestAdminReviewedSnapshots,
  verifiedSettlementFloorNotification,
  VERIFIED_SETTLEMENT_FLOOR_PURPOSE,
} from "./social-event-settlement-floor-core.js";

/**
 * Repair-safe notification boundary. It is intentionally called only after
 * the durable floor grant has reached `applied`.
 */
export async function ensureVerifiedSettlementFloorNotification(grantId: string): Promise<boolean> {
  const [grant] = await db
    .select()
    .from(communityEventRewardGrants)
    .where(and(
      eq(communityEventRewardGrants.id, grantId),
      eq(communityEventRewardGrants.purpose, VERIFIED_SETTLEMENT_FLOOR_PURPOSE),
      eq(communityEventRewardGrants.kind, "mushies"),
      eq(communityEventRewardGrants.status, "applied"),
    ))
    .limit(1);
  if (!grant || !grant.settlementId || !grant.amount) {
    throw new Error("VERIFIED_SETTLEMENT_FLOOR_GRANT_NOT_APPLIED");
  }
  const [settlement] = await db
    .select({ id: communityEventSocialSettlements.id })
    .from(communityEventSocialSettlements)
    .where(and(
      eq(communityEventSocialSettlements.id, grant.settlementId),
      eq(communityEventSocialSettlements.status, "completed"),
    ))
    .limit(1);
  if (!settlement) throw new Error("VERIFIED_SETTLEMENT_FLOOR_SETTLEMENT_NOT_COMPLETED");

  const entries = await db
    .select({ id: communityEventSocialEntries.id })
    .from(communityEventSocialEntries)
    .where(and(
      eq(communityEventSocialEntries.eventId, grant.eventId),
      eq(communityEventSocialEntries.userId, grant.userId),
      inArray(communityEventSocialEntries.status, ["initial_approved", "under_final_review", "settled"]),
    ));
  const entryIds = entries.map((entry) => entry.id);
  const snapshots = entryIds.length === 0 ? [] : await db
    .select()
    .from(communityEventSocialMetricSnapshots)
    .where(and(
      inArray(communityEventSocialMetricSnapshots.entryId, entryIds),
      isNotNull(communityEventSocialMetricSnapshots.reviewerAdminId),
    ))
    .orderBy(
      desc(communityEventSocialMetricSnapshots.verifiedAt),
      desc(communityEventSocialMetricSnapshots.createdAt),
      desc(communityEventSocialMetricSnapshots.id),
    );
  const verifiedPostCount = [...latestAdminReviewedSnapshots(snapshots).values()]
    .filter(isVerifiedAccessibleSnapshot)
    .length;
  if (verifiedPostCount === 0) throw new Error("VERIFIED_SETTLEMENT_FLOOR_AUDIT_NOT_FOUND");

  const notification = verifiedSettlementFloorNotification({
    eventId: grant.eventId,
    settlementId: grant.settlementId,
    grantId: grant.id,
    amount: grant.amount,
    verifiedPostCount,
  });
  return notify(
    grant.userId,
    "social_event_settled",
    notification.payload,
    { dedupeKey: notification.dedupeKey },
  );
}

/**
 * Return only applied floor grants whose deterministic notification is absent.
 * An optional event scope supports a single-event repair; omitting it supports
 * an explicit all-event reconciliation for future rules-v2 events.
 */
export async function missingVerifiedSettlementFloorNotificationGrantIds(
  eventId?: string,
): Promise<string[]> {
  const eventPredicate = eventId
    ? sql`AND g.event_id = ${eventId}`
    : sql``;
  const result = await db.execute(sql`
    SELECT g.id
    FROM community_event_reward_grants g
    INNER JOIN community_event_social_settlements s
      ON s.id = g.settlement_id
      AND s.status = 'completed'
    LEFT JOIN ${notifications} n
      ON n.user_id = g.user_id
      AND n.type = 'social_event_settled'
      AND n.dedupe_key = 'verified-settlement-floor:' || g.id
    WHERE g.purpose = ${VERIFIED_SETTLEMENT_FLOOR_PURPOSE}
      AND g.kind = 'mushies'
      AND g.status = 'applied'
      ${eventPredicate}
      AND n.id IS NULL
    ORDER BY g.id
  `);
  return (result.rows as Array<{ id: string }>).map((row) => row.id);
}

/** Repair the floor notification attached to a settlement, if one is applied. */
export async function ensureAppliedSettlementFloorNotification(
  settlementId: string,
): Promise<"not_applicable" | "created" | "already_present"> {
  const [grant] = await db
    .select({ id: communityEventRewardGrants.id })
    .from(communityEventRewardGrants)
    .innerJoin(
      communityEventSocialSettlements,
      eq(communityEventSocialSettlements.id, communityEventRewardGrants.settlementId),
    )
    .where(and(
      eq(communityEventRewardGrants.settlementId, settlementId),
      eq(communityEventRewardGrants.purpose, VERIFIED_SETTLEMENT_FLOOR_PURPOSE),
      eq(communityEventRewardGrants.kind, "mushies"),
      eq(communityEventRewardGrants.status, "applied"),
      eq(communityEventSocialSettlements.status, "completed"),
    ))
    .limit(1);
  if (!grant) return "not_applicable";
  return await ensureVerifiedSettlementFloorNotification(grant.id)
    ? "created"
    : "already_present";
}
