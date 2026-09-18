import assert from "node:assert/strict";
import test from "node:test";
import {
  assertVerifiedSettlementFloorGrantMatches,
  isVerifiedAccessibleSnapshot,
  latestAdminReviewedSnapshots,
  summarizeSettlementPayouts,
  verifiedSettlementFloorNotification,
  verifiedSettlementFloorGrantKey,
} from "./social-event-settlement-floor-core.js";

const snapshot = (overrides: Partial<{
  id: string;
  entryId: string;
  reviewerAdminId: string | null;
  resolution: string;
  linkStatus: string;
  verifiedAt: string;
  createdAt: string;
}> = {}) => ({
  id: "snapshot-a",
  entryId: "entry-a",
  reviewerAdminId: "admin-a",
  resolution: "official_link_check",
  linkStatus: "accessible",
  verifiedAt: "2026-08-29T10:00:00.000Z",
  createdAt: "2026-08-29T10:00:00.000Z",
  ...overrides,
});

test("only an admin official-link snapshot marked accessible qualifies", () => {
  assert.equal(isVerifiedAccessibleSnapshot(snapshot()), true);
  assert.equal(isVerifiedAccessibleSnapshot(snapshot({ reviewerAdminId: null })), false);
  assert.equal(isVerifiedAccessibleSnapshot(snapshot({ resolution: "user_evidence" })), false);
  assert.equal(isVerifiedAccessibleSnapshot(snapshot({ linkStatus: "unavailable" })), false);
});

test("latest snapshot selection is deterministic and does not fall back to an older accessible post", () => {
  const latest = latestAdminReviewedSnapshots([
    snapshot({ id: "snapshot-old", linkStatus: "accessible" }),
    snapshot({ id: "snapshot-new", linkStatus: "unavailable", createdAt: "2026-08-29T10:01:00.000Z" }),
    snapshot({ id: "snapshot-user", reviewerAdminId: null, createdAt: "2026-08-29T10:02:00.000Z" }),
  ]).get("entry-a");
  assert.equal(latest?.id, "snapshot-new");
  assert.equal(latest ? isVerifiedAccessibleSnapshot(latest) : true, false);

  const tied = latestAdminReviewedSnapshots([
    snapshot({ id: "snapshot-a" }),
    snapshot({ id: "snapshot-z" }),
  ]).get("entry-a");
  assert.equal(tied?.id, "snapshot-z");

  const perEntry = latestAdminReviewedSnapshots([
    snapshot({ id: "entry-a-older", verifiedAt: "2026-08-29T09:00:00.000Z" }),
    snapshot({ id: "entry-a-newer", verifiedAt: "2026-08-29T11:00:00.000Z" }),
    snapshot({ id: "entry-b", entryId: "entry-b", verifiedAt: "2026-08-29T10:30:00.000Z" }),
  ]);
  assert.equal(perEntry.get("entry-a")?.id, "entry-a-newer");
  assert.equal(perEntry.get("entry-b")?.id, "entry-b");
});

test("floor payouts stay separate from performance settlement payouts", () => {
  const summary = summarizeSettlementPayouts({
    calculatedPerformanceTopUpMushies: 0,
    calculatedFloorTopUp: 1_000,
    grants: [
      { phase: "initial", purpose: null, kind: "mushies", amount: 2_000, status: "applied" },
      { phase: "final", purpose: null, kind: "mushies", amount: 500, status: "failed" },
      { phase: "adjustment", purpose: "verified_settlement_floor", kind: "mushies", amount: 1_000, status: "applied" },
    ],
  });
  assert.equal(summary.calculatedFinalPayoutMushies, 1_000);
  assert.equal(summary.appliedPerformanceTopUpMushies, 0);
  assert.equal(summary.appliedFloorTopUp, 1_000);
  assert.equal(summary.appliedFinalPayoutMushies, 1_000);
  assert.equal(summary.floorGrantStatus, "applied");

  for (const status of ["failed", "processing", "pending"] as const) {
    const state = summarizeSettlementPayouts({
      calculatedPerformanceTopUpMushies: 500,
      calculatedFloorTopUp: 1_000,
      grants: [
        { phase: "final", purpose: null, kind: "mushies", amount: 500, status: "failed" },
        { phase: "adjustment", purpose: "verified_settlement_floor", kind: "mushies", amount: 1_000, status },
      ],
    });
    assert.equal(state.appliedPerformanceTopUpMushies, 0);
    assert.equal(state.appliedFloorTopUp, 0);
    assert.equal(state.appliedFinalPayoutMushies, 0);
    assert.equal(state.floorGrantStatus, status);
  }

  assert.equal(summarizeSettlementPayouts({
    calculatedPerformanceTopUpMushies: 0,
    calculatedFloorTopUp: 0,
    grants: [],
  }).floorGrantStatus, null);
});

test("floor grant keys are versioned and immutable fields are validated", () => {
  assert.equal(
    verifiedSettlementFloorGrantKey({ eventId: "event", userId: "user", rulesVersion: 2 }),
    "event:event:user:user:verified-settlement-floor:rules-v2:mushies",
  );
  assert.equal(
    verifiedSettlementFloorGrantKey({ eventId: "event", userId: "user", backfillVersion: 1 }),
    "event:event:user:user:verified-settlement-floor:backfill-v1:mushies",
  );
  const grant = {
    eventId: "event",
    userId: "user",
    settlementId: "settlement",
    purpose: "verified_settlement_floor",
    kind: "mushies",
    phase: "adjustment",
    amount: 1_000,
  };
  assert.doesNotThrow(() => assertVerifiedSettlementFloorGrantMatches(grant, {
    eventId: "event",
    userId: "user",
    settlementId: "settlement",
    amount: 1_000,
  }));
  assert.throws(() => assertVerifiedSettlementFloorGrantMatches(grant, {
    eventId: "event",
    userId: "user",
    settlementId: "settlement",
    amount: 999,
  }), /FLOOR_GRANT_CONFLICT/);
  assert.throws(
    () => verifiedSettlementFloorGrantKey({ eventId: "event", userId: "user" }),
    /RULES_VERSION_REQUIRED/,
  );
});

test("floor notification payload is validated and carries a deterministic dedupe key", () => {
  const notification = verifiedSettlementFloorNotification({
    eventId: "event",
    settlementId: "settlement",
    grantId: "grant",
    amount: 1_000,
    verifiedPostCount: 2,
  });
  assert.equal(notification.dedupeKey, "verified-settlement-floor:grant");
  assert.deepEqual(notification.payload, {
    eventId: "event",
    settlementId: "settlement",
    grantId: "grant",
    amount: 1_000,
    verifiedPostCount: 2,
    rewardStatus: "verified_floor_applied",
    dedupeKey: "verified-settlement-floor:grant",
    i18nKey: "community.events.social.settlement.verifiedFloorApplied",
  });
  assert.throws(() => verifiedSettlementFloorNotification({
    eventId: "event",
    settlementId: "settlement",
    grantId: "grant",
    amount: 0,
    verifiedPostCount: 2,
  }), /AMOUNT_INVALID/);
  assert.throws(() => verifiedSettlementFloorNotification({
    eventId: "event",
    settlementId: "settlement",
    grantId: "grant",
    amount: 1_000,
    verifiedPostCount: 0,
  }), /AUDIT_INVALID/);
});
