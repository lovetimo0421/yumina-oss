import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";

/**
 * Admin middleware — requires authMiddleware to run first.
 * Always queries the DB for the user's role (never trusts session cache).
 */
export const adminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const currentUser = c.get("user");

  const [row] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, currentUser.id));

  if (!row || row.role !== "admin") {
    return c.json({ error: "Forbidden — admin access required" }, 403);
  }

  await next();
});
