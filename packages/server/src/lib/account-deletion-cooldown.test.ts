import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_DELETION_COOLDOWN_DAYS,
  accountDeletionBlockedUntil,
} from "./account-deletion-cooldown.js";

test("recreated identities cannot delete again for three full days", () => {
  assert.equal(ACCOUNT_DELETION_COOLDOWN_DAYS, 3);
  const deletedAt = new Date("2026-07-31T06:00:00.000Z");

  assert.equal(
    accountDeletionBlockedUntil(
      deletedAt,
      new Date("2026-08-03T05:59:59.999Z"),
    )?.toISOString(),
    "2026-08-03T06:00:00.000Z",
  );
  assert.equal(
    accountDeletionBlockedUntil(
      deletedAt,
      new Date("2026-08-03T06:00:00.000Z"),
    ),
    null,
  );
  assert.equal(accountDeletionBlockedUntil(null), null);
});
