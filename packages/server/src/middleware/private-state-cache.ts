import type { MiddlewareHandler } from "hono";

// Mutable, account-specific reads must never survive a reload as an HTTP
// cache entry. Public discovery feeds retain their explicit cache policies.
const PRIVATE_STATE_PATH = /^\/api\/(?:admin(?:\/|$)|referrals(?:\/|$)|invite-codes\/(?:welcome|redeem)\/?$|tips\/(?:giftable-balance|mushie)\/?$|users\/me(?:\/|$)|check-ins(?:\/|$)|subscription\/status\/?$|sessions(?:\/|$)|keys(?:\/|$)|models\/?$)/;

export const privateStateCache: MiddlewareHandler = async (c, next) => {
  if (!PRIVATE_STATE_PATH.test(c.req.path)) return next();
  c.header("Cache-Control", "private, no-store");
  c.header("CDN-Cache-Control", "no-store");
  await next();
  // Streaming routes supply their own no-cache/no-transform policy.
  if (c.res.headers.get("content-type")?.includes("text/event-stream")) return;
  c.header("Cache-Control", "private, no-store");
  c.header("CDN-Cache-Control", "no-store");
};
