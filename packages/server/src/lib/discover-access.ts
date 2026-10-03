import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";
/** Explicit launch switch; caller input never grants access. Fresh primary role bypasses session caches. */
export async function discoverAccess(userId?: string) {
  const publicEnabled = process.env.DISCOVER_PUBLIC_ENABLED === "true";
  if (publicEnabled) return { enabled: true, publicEnabled };
  const [actor] = userId ? await db.select({ role: user.role, isBanned: user.isBanned }).from(user).where(eq(user.id, userId)).limit(1) : [];
  return { enabled: actor?.role === "admin" && !actor.isBanned, publicEnabled };
}
