import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { executeNotificationDelete } from "./notification-delete-action.js";

describe("notification deletion", () => {
  it("deletes using both the notification ID and signed-in owner", () => {
    const source = readFileSync(new URL("./notification-delete.ts", import.meta.url), "utf8");
    assert.match(source, /eq\(notifications\.id, notificationId\)/);
    assert.match(source, /eq\(notifications\.userId, userId\)/);
  });

  it("reports success and marks the owner's read-after-write state", async () => {
    const calls: string[] = [];
    const deleted = await executeNotificationDelete("owner-1", "notification-1", {
      deleteOwned: async (userId, notificationId) => {
        calls.push(`delete:${userId}:${notificationId}`);
        return true;
      },
      flagWrite: (userId) => calls.push(`flag:${userId}`),
    });

    assert.equal(deleted, true);
    assert.deepEqual(calls, ["delete:owner-1:notification-1", "flag:owner-1"]);
  });

  it("reports missing or foreign notifications without marking a write", async () => {
    const calls: string[] = [];
    const deleted = await executeNotificationDelete("owner-1", "foreign-or-missing", {
      deleteOwned: async (userId, notificationId) => {
        calls.push(`delete:${userId}:${notificationId}`);
        return false;
      },
      flagWrite: (userId) => calls.push(`flag:${userId}`),
    });

    assert.equal(deleted, false);
    assert.deepEqual(calls, ["delete:owner-1:foreign-or-missing"]);
  });
});
