import { db, dbRead } from "../db/index.js";
import { sql } from "drizzle-orm";
import { redis } from "../lib/redis.js";
import { createHealthRoutes } from "../lib/health-check.js";
import { withDatabaseQueryTimeout } from "../db/query-deadline.js";
import { captureServerError } from "../lib/posthog.js";

const health = createHealthRoutes({
  // Await inside the timeout scope: Drizzle queries are lazy thenables.
  db: () => withDatabaseQueryTimeout(4_000, async () => await db.execute(sql`SELECT 1`)),
  ...(dbRead !== db ? { dbRead: () => withDatabaseQueryTimeout(4_000, async () => await (dbRead as typeof db).execute(sql`SELECT 1`)) } : {}),
  ...(redis ? { redis: () => redis!.ping() } : {}),
}, {
  onDegraded: (failed) => {
    console.error("[HEALTH] Degraded:", failed.join(", "));
    captureServerError("health-degraded", new Error("Dependency health check failed"), { failed_checks: failed });
  },
});

// Clients poll this to notice a new deploy and refresh themselves.
health.get("/release", (c) => {
  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  return c.json({ release: process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || null });
});

export { health };
