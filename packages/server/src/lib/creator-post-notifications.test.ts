import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications, user } from "../db/schema.js";
import { notify, notifyMany } from "./notify.js";

const userIds: string[] = [];
async function recipient(preferences: Record<string, unknown>) {
  const id = `creator-notice-test-${crypto.randomUUID()}`;
  await db.insert(user).values({ id, name: "Reader", email: `${id}@test.local`, preferences });
  userIds.push(id);
  return id;
}
async function received(id: string) {
  return db.select().from(notifications).where(eq(notifications.userId, id));
}
after(async () => {
  if (!userIds.length) return;
  await db.delete(notifications).where(inArray(notifications.userId, userIds));
  await db.delete(user).where(inArray(user.id, userIds));
});

test("creator-post opt-out filters both single and broadcast delivery; enabling resumes delivery", async () => {
  const optedOut = await recipient({ notificationPreferences: { creatorPosts: false } });
  const enabled = await recipient({ notificationPreferences: { creatorPosts: true } });
  const legacy = await recipient({});
  const payload = { threadId: "creator-post" };

  assert.equal(await notify(optedOut, "creator_community_post", payload), false);
  await notifyMany([optedOut, enabled, legacy], "creator_community_post", payload);
  assert.equal((await received(optedOut)).length, 0);
  assert.equal((await received(enabled)).length, 1);
  assert.equal((await received(legacy)).length, 1);

  await db.update(user).set({ preferences: { notificationPreferences: { creatorPosts: true } } }).where(eq(user.id, optedOut));
  assert.equal(await notify(optedOut, "creator_community_post", payload), true);
  await notifyMany([optedOut], "creator_community_post", payload);
  assert.equal((await received(optedOut)).length, 2);
});

test("creator-post opt-out does not suppress follows, replies, card updates or announcements", async () => {
  const id = await recipient({ notificationPreferences: { creatorPosts: false } });
  const types = ["new_follower", "followed_user_published", "thread_reply", "world_update", "platform_announcement"] as const;
  for (const type of types) assert.equal(await notify(id, type, {}), true);
  assert.deepEqual((await received(id)).map((row) => row.type).sort(), [...types].sort());
});

test("social and subject mutes still override an enabled creator-post preference", async () => {
  const socialMuted = await recipient({ notificationPreferences: { social: false, creatorPosts: true } });
  const subjectMuted = await recipient({
    notificationPreferences: { creatorPosts: true },
    mutedNotificationSubjects: ["thread:muted-post"],
  });
  for (const id of [socialMuted, subjectMuted]) {
    assert.equal(await notify(id, "creator_community_post", { threadId: "muted-post" }), false);
  }
  await notifyMany([socialMuted, subjectMuted], "creator_community_post", { threadId: "muted-post" });
  assert.equal((await received(socialMuted)).length, 0);
  assert.equal((await received(subjectMuted)).length, 0);
});
