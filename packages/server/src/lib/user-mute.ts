import { eq } from "drizzle-orm";
import { user, adminActions } from "../db/schema.js";
import type { db } from "../db/index.js";
import { muteExpiresAt, type MuteDuration } from "@yumina/shared";
import { invalidateSessionUser } from "./session-user-cache.js";

export async function setUserMute(database: Pick<typeof db, "transaction">, actorId: string, targetId: string, duration: MuteDuration | null, now = new Date()) {
  if (actorId === targetId) return "self" as const;
  const mutedUntil = duration ? muteExpiresAt(duration, now) : null;
  const result = await database.transaction(async (tx) => {
    const [actor] = await tx.select({ role: user.role }).from(user).where(eq(user.id, actorId));
    if (actor?.role !== "admin") return "forbidden" as const;
    const [target] = await tx.select({ id: user.id, role: user.role })
      .from(user).where(eq(user.id, targetId)).for("update");
    if (!target) return "missing" as const;
    if (target.role === "admin") return "admin" as const;
    await tx.update(user).set({ isMuted: duration !== null, mutedUntil, updatedAt: now })
      .where(eq(user.id, targetId));
    await tx.insert(adminActions).values({
      adminId: actorId, actionType: duration ? "user_mute" : "user_unmute",
      targetType: "user", targetId,
      metadata: { duration, mutedUntil: mutedUntil?.toISOString() ?? null },
    });
    return "ok" as const;
  });
  // isMuted / mutedUntil ride in the 60s session-user cache the auth
  // middleware reads; without this a mute (or unmute) lagged up to a minute.
  // After commit, so a concurrent auth cannot re-cache the old row.
  if (result === "ok") await invalidateSessionUser(targetId);
  return result;
}
