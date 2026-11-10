import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds } from "../db/schema.js";
import { filterWorldAudience, hiddenWorldIds, isWorldAudienceRestricted } from "./world-publication-access.js";

/** Authorize recipients independently, including already-open SSE streams. */
export async function filterWorldAudienceDelivery(userId: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const candidates = hiddenWorldIds("", false);
  if (!candidates.length) return payload;
  const referencesCard = (value: unknown): boolean => typeof value === "string"
    ? candidates.includes(value)
    : Boolean(value && typeof value === "object" && Object.values(value).some(referencesCard));
  if (!referencesCard(payload)) return payload;
  const [recipient] = await db.select({ role: user.role, isBanned: user.isBanned, isSuspended: user.isSuspended }).from(user).where(eq(user.id, userId)).limit(1);
  const isAdmin = recipient?.role === "admin" && !recipient.isBanned && !recipient.isSuspended;
  const hidden = hiddenWorldIds(userId, isAdmin);
  if (!hidden.length) return payload;
  const rows = await db.select({ id: worlds.id, creatorId: worlds.creatorId }).from(worlds).where(inArray(worlds.id, hidden));
  const ids = new Set(rows.filter(row => isWorldAudienceRestricted(row.id, row.creatorId)).map(row => row.id));
  return filterWorldAudience(payload, ids) as Record<string, unknown> | undefined;
}
