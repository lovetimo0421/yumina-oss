import { Hono } from "hono";
import type { AppEnv } from "../lib/types.js";
import { optionalAuthMiddleware } from "../middleware/auth.js";
import { discoverAccess } from "../lib/discover-access.js";
export const discoverRoutes = new Hono<AppEnv>();
discoverRoutes.get("/access", optionalAuthMiddleware, async c => {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  return c.json({ data: await discoverAccess(c.get("user")?.id) });
});
