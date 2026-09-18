import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { userMutes } from "../db/schema.js";
import { createCommunityMuteMiddleware } from "../lib/mute-policy.js";

// Read from primary on every write: a new mute or revocation takes effect
// immediately, without waiting for session caches or read replicas.
export const communityMuteMiddleware = createCommunityMuteMiddleware(async (userId) => {
  const [mute] = await db.select().from(userMutes).where(eq(userMutes.userId, userId)).limit(1);
  return mute ?? null;
});
