import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { inviteCodes, user } from "../db/schema.js";
import { invalidateSessionUser } from "./session-user-cache.js";

export function blocksLimitlessPreference(limitedOnly: boolean | undefined, prefs: Record<string, unknown>): boolean {
  return limitedOnly === true && (Boolean(prefs.showNsfw) || (typeof prefs.contentLevel === "string" && prefs.contentLevel !== "safe"));
}

export function inviteContentPreferences(allowLimitless: boolean, defaultModel: string | null): Record<string, unknown> {
  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(!allowLimitless ? { contentLevel: "safe", showNsfw: false } : {}),
  };
}

export const INVITE_CONTENT_COOKIE = "yumina_invite_content";

export async function applySignupInviteContentAccess(userId: string, headers: Headers | undefined): Promise<void> {
  const code = /(?:^|;\s*)yumina_invite_content=([A-Z0-9]{5,8})(?:;|$)/.exec(headers?.get("cookie") ?? "")?.[1];
  if (!code) return;
  await db.transaction(async (tx) => {
    const [invite] = await tx.select({ id: inviteCodes.id, allowLimitless: inviteCodes.allowLimitless, isActive: inviteCodes.isActive })
      .from(inviteCodes).where(eq(inviteCodes.code, code)).for("update");
    if (!invite?.isActive) return;
    await tx.update(user).set({ inviteCodeId: invite.id, limitedContentOnly: !invite.allowLimitless,
      ...(!invite.allowLimitless ? { preferences: sql`coalesce(${user.preferences}, '{}'::jsonb) || '{"contentLevel":"safe","showNsfw":false}'::jsonb` } : {}),
    }).where(eq(user.id, userId));
  });
  await invalidateSessionUser(userId);
}

/** The code row lock serializes changes with redemption. Restrictions survive code deletion. */
export async function setInviteLimitlessAccess(id: string, allowLimitless: boolean): Promise<boolean> {
  const changed = await db.transaction(async (tx) => {
    const [code] = await tx.select({ id: inviteCodes.id }).from(inviteCodes).where(eq(inviteCodes.id, id)).for("update");
    if (!code) return null;
    await tx.update(inviteCodes).set({ allowLimitless }).where(eq(inviteCodes.id, id));
    await tx.update(user).set({
      limitedContentOnly: !allowLimitless,
      ...(!allowLimitless ? { preferences: sql`coalesce(${user.preferences}, '{}'::jsonb) || '{"contentLevel":"safe","showNsfw":false}'::jsonb` } : {}),
      updatedAt: new Date(),
    }).where(eq(user.inviteCodeId, id));
    return tx.select({ id: user.id }).from(user).where(eq(user.inviteCodeId, id));
  });
  if (!changed) return false;
  await Promise.all(changed.map(row => invalidateSessionUser(row.id)));
  return true;
}
