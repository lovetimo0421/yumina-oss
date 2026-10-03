import assert from "node:assert/strict";
import test from "node:test";
import { mergeReferralClaims } from "./referral-claim-history.js";

test("deletion preserves claimed milestones in the current reward period", () => {
  const epoch = new Date("2026-07-16T00:00:00Z");
  assert.deepEqual(mergeReferralClaims(epoch, [5], [
    { epoch: epoch.toISOString(), milestones: [1, 5] },
    { epoch: "2026-01-01T00:00:00.000Z", milestones: [10] },
  ]), { epoch: epoch.toISOString(), milestones: [1, 5] });
});
