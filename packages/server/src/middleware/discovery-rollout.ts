import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../lib/types.js";

/** The local edition rejects Hub before this boundary; no hosted cohort or
 * capacity implementation is included in the exported application. */
export function createDiscoveryRolloutMiddleware(_options: {
  secret: string;
  rateLimit?: MiddlewareHandler<AppEnv>;
  environment?: () => Record<string, string | undefined>;
  capacity?: { acquire(kind: "fresh" | "continuation"): () => void };
}): MiddlewareHandler<AppEnv> {
  return async (_context, next) => { await next(); };
}
