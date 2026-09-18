import { z } from "zod";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types.js";

export const muteInputSchema = z.object({
  durationDays: z.number().int().min(1).max(3650),
  reason: z.string().trim().max(500).default(""),
});

export type MuteState = { expiresAt: Date; revokedAt: Date | null };

export function isMuteActive(mute: MuteState | null | undefined, now = new Date()): boolean {
  return !!mute && mute.revokedAt === null && mute.expiresAt.getTime() > now.getTime();
}

export function createCommunityMuteMiddleware(loadMute: (userId: string) => Promise<MuteState | null>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const mute = await loadMute(c.get("user").id);
    if (isMuteActive(mute)) {
      const mutedUntil = mute!.expiresAt.toISOString();
      const zh = (c.req.header("Accept-Language") ?? "").toLowerCase().startsWith("zh");
      return c.json({
        error: zh
          ? `你已被禁言，暂时无法在社区和评论区发言。解禁时间：${mutedUntil}`
          : `You are muted from community posts and comments until ${mutedUntil}.`,
        code: "COMMUNITY_MUTED",
        mutedUntil,
      }, 403);
    }
    await next();
  });
}
