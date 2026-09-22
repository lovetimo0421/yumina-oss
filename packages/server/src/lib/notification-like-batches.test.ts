import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { recordNotificationLikeVisit } from "./notification-like-batches.js";

test("visits track new grouped actions for the signed-in recipient and preserve legacy like history", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
        payload JSONB NOT NULL, read BOOLEAN NOT NULL DEFAULT false
      );
      INSERT INTO notifications (id, user_id, type, payload, read) VALUES
        ('old', 'owner', 'post_like', '{"postId":"p","likeBatchId":"previous"}', false),
        ('read', 'owner', 'post_like', '{"postId":"p"}', true),
        ('new-a', 'owner', 'post_like', '{"postId":"p","likerName":"A"}', false),
        ('new-b', 'owner', 'post_like', '{"postId":"p"}', false),
        ('thread', 'owner', 'thread_like', '{}', false),
        ('bundle', 'owner', 'bundle_like', '{}', false),
        ('favorite', 'owner', 'new_favorite', '{}', false),
        ('reply', 'owner', 'post_reply', '{}', false),
        ('thread-reply', 'owner', 'thread_reply', '{}', false),
        ('review-reply', 'owner', 'new_review_reply', '{}', false),
        ('comment', 'owner', 'new_comment', '{}', false),
        ('follower', 'owner', 'new_follower', '{}', false),
        ('system', 'owner', 'platform_announcement', '{}', false),
        ('foreign', 'someone-else', 'post_like', '{}', false);
    `);
    const executor = drizzle(database);
    await recordNotificationLikeVisit(executor, "owner", "visit-1");
    const rows = (await database.query<{ id: string; payload: Record<string, unknown>; read: boolean }>(
      "SELECT id, payload, read FROM notifications ORDER BY id",
    )).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get("old")!.payload.likeBatchId, "previous");
    assert.equal(byId.get("old")!.payload.activityBatchId, "previous");
    assert.equal(byId.get("read")!.payload.activityBatchId, "history");
    for (const id of ["new-a", "new-b", "thread", "bundle", "favorite", "reply", "thread-reply", "review-reply", "comment", "follower"]) {
      assert.equal(byId.get(id)!.payload.activityBatchId, "visit-1");
      assert.equal(byId.get(id)!.read, false);
    }
    assert.equal(byId.get("new-a")!.payload.likerName, "A");
    assert.equal(byId.get("foreign")!.payload.activityBatchId, undefined);
    assert.equal(byId.get("system")!.payload.activityBatchId, undefined);

    await recordNotificationLikeVisit(executor, "owner", "empty-visit");
    assert.deepEqual((await database.query("SELECT id, payload, read FROM notifications ORDER BY id")).rows, rows);
    await database.exec(`INSERT INTO notifications (id, user_id, type, payload)
      VALUES ('later', 'owner', 'post_like', '{"postId":"p"}')`);
    await recordNotificationLikeVisit(executor, "owner", "visit-2");
    const later = (await database.query<{ id: string; batch: string }>(
      "SELECT id, payload->>'activityBatchId' AS batch FROM notifications WHERE id IN ('new-a', 'later') ORDER BY id",
    )).rows;
    assert.deepEqual(later, [{ id: "later", batch: "visit-2" }, { id: "new-a", batch: "visit-1" }]);
  } finally {
    await database.close();
  }
});
