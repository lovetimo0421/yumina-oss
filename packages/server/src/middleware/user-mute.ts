import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { userMutes } from "../db/schema.js";
import { effectiveMute, type MuteState } from "../lib/mute-policy.js";
import type { AppEnv } from "../lib/types.js";

/**
 * Must follow authMiddleware, which reads moderation fields from the primary.
 *
 * Gates on BOTH mute stores. The account fields this used to read are written
 * by the account moderation screen; `user_mutes` is written by the community
 * one. Reading only the first left direct messages, event submissions, wall
 * posts and update notes open to someone muted through the second.
 *
 * The community lookup is injected for the same reason the community gate
 * injects it: a middleware that reaches for the global connection cannot be
 * exercised without standing one up.
 */
export function createAccountMuteMiddleware(loadMute: (userId: string) => Promise<MuteState | null>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    const mute = effectiveMute(user, await loadMute(user.id));
    if (mute) {
      const mutedUntil = mute.mutedUntil?.toISOString() ?? null;
      return c.json({
        code: "USER_MUTED",
        userId: user.id,
        error: mutedUntil ? `You are muted until ${mutedUntil}.` : "You are permanently muted.",
        isMuted: true,
        mutedUntil,
      }, 403);
    }
    await next();
  });
}

// Read from the primary on every write, like the community gate: a new mute or
// a revocation takes effect immediately, without waiting for a session cache.
export const requireUnmuted = createAccountMuteMiddleware(async (userId) => {
  const [mute] = await db.select().from(userMutes).where(eq(userMutes.userId, userId)).limit(1);
  return mute ?? null;
});
