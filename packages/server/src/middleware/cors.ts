import { cors } from "hono/cors";
import { env, PUBLIC_ORIGIN } from "../lib/env.js";

const isDev = process.env.NODE_ENV !== "production";

// Production allowlist — must include every subdomain that may run the SPA
// or call the API cross-origin. Most calls today are same-origin (the SPA
// is served from the same Railway service), but the OAuth post-callback
// redirect and any third-party widget will fail without an explicit entry.
const ALLOWED_ORIGINS = new Set(
  [
    PUBLIC_ORIGIN,
    env.APP_URL,
    env.BETTER_AUTH_URL,
    "https://yumina.io",
    "https://www.yumina.io",
    "https://creator.yumina.io",
  ].filter(Boolean) as string[],
);

export const corsMiddleware = cors({
  origin: isDev
    ? (origin) => origin
    : (origin) => (origin && ALLOWED_ORIGINS.has(origin) ? origin : env.APP_URL),
  allowHeaders: ["Content-Type", "Authorization", "X-Yumina-Wallet-Version", "X-Discovery-Account"],
  exposeHeaders: ["X-Agent-Run-Id", "Date"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
  maxAge: 86400,
});
