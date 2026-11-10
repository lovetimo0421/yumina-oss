import { z } from "zod";
import { createMiddleware } from "hono/factory";
import { isUserMuted, type UserMuteState } from "@yumina/shared";
import type { AppEnv } from "./types.js";

export const muteInputSchema = z.object({
  durationDays: z.number().int().min(1).max(3650),
  reason: z.string().trim().max(500).default(""),
});

export type MuteState = { expiresAt: Date; revokedAt: Date | null };

export function isMuteActive(mute: MuteState | null | undefined, now = new Date()): boolean {
  return !!mute && mute.revokedAt === null && mute.expiresAt.getTime() > now.getTime();
}

/**
 * A mute lives in two places, and both have to count.
 *
 * `user.isMuted` / `user.mutedUntil` is what the account moderation screen
 * writes (and the only one that can express a permanent mute). `user_mutes` is
 * what the community moderation screen writes (with a reason and an admin, and
 * always with an expiry). Each gate used to read only its own store, so a mute
 * applied on one screen left the other half of the site open.
 *
 * Returns the mute that actually binds — the longer of the two, with a
 * permanent one beating any dated one — or null when neither is active.
 */
export function effectiveMute(
  account: UserMuteState | null | undefined,
  community: MuteState | null | undefined,
  now = new Date(),
): { mutedUntil: Date | null } | null {
  const accountActive = !!account && isUserMuted(account, now.getTime());
  const communityActive = isMuteActive(community, now);
  if (!accountActive && !communityActive) return null;
  if (accountActive && account!.mutedUntil == null) return { mutedUntil: null };
  const accountUntil = accountActive ? new Date(account!.mutedUntil as Date | string) : null;
  const communityUntil = communityActive ? community!.expiresAt : null;
  if (accountUntil && communityUntil) {
    return { mutedUntil: accountUntil.getTime() >= communityUntil.getTime() ? accountUntil : communityUntil };
  }
  return { mutedUntil: accountUntil ?? communityUntil };
}

export function createCommunityMuteMiddleware(loadMute: (userId: string) => Promise<MuteState | null>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const account = c.get("user");
    const mute = effectiveMute(account, await loadMute(account.id));
    if (mute) {
      const mutedUntil = mute.mutedUntil?.toISOString() ?? null;
      const zh = (c.req.header("Accept-Language") ?? "").toLowerCase().startsWith("zh");
      return c.json({
        error: mutedUntil
          ? zh
            ? `你已被禁言，暂时无法在社区和评论区发言。解禁时间：${mutedUntil}`
            : `You are muted from community posts and comments until ${mutedUntil}.`
          : zh
            ? "你已被永久禁言，无法在社区和评论区发言。"
            : "You are permanently muted from community posts and comments.",
        code: "COMMUNITY_MUTED",
        mutedUntil,
      }, 403);
    }
    await next();
  });
}
