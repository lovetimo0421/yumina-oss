import "./utc-init.js"; // MUST be first — pins the process to UTC before any Date use
import fs from "node:fs";
import { Hono } from "hono";
import type { Context } from "hono";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { preloadTokenizer } from "@yumina/engine";
import { env } from "./lib/env.js";
import { privateStateCache } from "./middleware/private-state-cache.js";
import {
  db,
  ensureAccountDeletionForeignKeys,
  ensureAnalyticsRollupTables,
  ensureBundleTagsConstraint,
  ensureCheckInTables,
  ensureBillingV2Schema,
  ensureQuestBoardSchema,
  ensureTranslationAttemptsTable,
  ensureCommunityEventTables,
  ensureCommunityImageColumns,
  ensureCommunityOfficialColumn,
  ensureDmSchema,
  ensureExtensionTables,
  ensureMessagesSwipeCount,
  ensurePlatformAchievementTables,
  ensureHotPathIndexes,
  ensureProfileWallTable,
  ensureScheduledFunctions,
  ensureSessionContextColumns,
  ensureTables,
  ensureWorldReviewControlsColumn,
  ensureSessionPersonaColumn,
  ensureWorldReviewTables,
  ensureWorldTagsConstraint,
  ensureWorldsSchemaDerived,
  flagWrite,
  seedPlatformAchievements,
  ensureJwksTable,
} from "./db/index.js";
import { sql } from "drizzle-orm";
import { bootstrapPgliteSchema } from "./db/bootstrap-pglite.js";
import { corsMiddleware } from "./middleware/cors.js";
import { health } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { users } from "./routes/users.js";
import { worldRoutes } from "./routes/worlds.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { sessionRoutes } from "./routes/sessions.js";
import { sessionMemoryRoutes } from "./routes/session-memory.js";
import { stateGuardRoutes } from "./routes/state-update-guard.js";
import { messageRoutes } from "./routes/messages.js";
import { studioRoutes } from "./routes/studio.js";
import { assetRoutes } from "./routes/assets.js";
import { userPromptsRoutes } from "./routes/user-prompts.js";
import { userPresetOverridesRoutes } from "./routes/user-preset-overrides.js";
import { userAssetRoutes } from "./routes/user-assets.js";
import { assetRefRoutes } from "./routes/asset-references.js";
import { folderBindingRoutes } from "./routes/folder-bindings.js";
import { personaRoutes } from "./routes/personas.js";
import { agentRoutes } from "./routes/agent.js";
import { cdnRoutes } from "./routes/cdn.js";
import { ensureLifetimePlaytimePending } from "./lib/lifetime-playtime-counter.js";
import { stopRateLimitCleanup } from "./middleware/rate-limit.js";
import { devRoutes } from "./routes/dev.js";
import { extensionRoutes } from "./routes/extensions.js";
import { localAuthRoutes } from "./routes/local-auth.js";
import { completionRoutes } from "./routes/completions.js";
import { socialSimulatorRoutes } from "./routes/social-simulator.js";
import { combatRoutes } from "./routes/combat.js";
import { BIND_HOST, IS_DEV } from "./lib/env.js";
import { isTestingRequest } from "./lib/testing-origin.js";
import { connectRedis, disconnectRedis } from "./lib/redis.js";
import { posthog, captureServerError } from "./lib/posthog.js";
import { drainStreams, activeStreamCount } from "./lib/stream-registry.js";
import { getMetaForPath, injectMeta } from "./lib/seo.js";
import { registerSessionMemoryExtension } from "./extensions/session-memory/hooks.js";
import { registerStateUpdateGuard } from "./extensions/state-update-guard/hooks.js";
import { runWithRequestCache } from "./lib/request-cache.js";
import { edition, editionRoutes } from "./edition/index.js";
import { storageRoutes } from "./routes/storage.js";

// Register first-party extension hooks before any request is served — the
// message pipeline dispatches through the registry instead of hardcoding
// per-feature checks.
registerSessionMemoryExtension();
registerStateUpdateGuard();

// Last-resort process-level handlers. Without these, any unhandled 'error'
// event or stray rejection from a fire-and-forget promise crashes the whole
// instance and kills every in-flight SSE stream on it.
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
  captureServerError("unhandledRejection", reason);
});
process.on("uncaughtException", (err, origin) => {
  console.error(`[UNCAUGHT EXCEPTION] (${origin})`, err);
  captureServerError("uncaughtException", err, { origin: String(origin) });
  // State may be corrupt after an uncaught exception — flush telemetry so the
  // crash report survives, then exit non-zero so Railway restarts the instance.
  const forceExit = setTimeout(() => process.exit(1), 3_000);
  void Promise.resolve(posthog.shutdown())
    .catch(() => {})
    .then(() => {
      clearTimeout(forceExit);
      process.exit(1);
    });
});

import { startRuntimeMonitor } from "./lib/runtime-monitor.js";
import { captureBoundedCpuProfile } from "./lib/cpu-profile.js";
import { runtimeIdentity } from "./lib/runtime-identity.js";
import { findDatabaseQueryTimeout, withDatabaseQueryTimeout } from "./db/query-deadline.js";
const stopRuntimeMonitor = startRuntimeMonitor((event, properties) => {
  console.log(`[${event === "event_loop_lag" ? "LOOP" : "RUNTIME"}] ${JSON.stringify(properties)}`);
  posthog.capture({ distinctId: "server", event, properties });
});

const app = new Hono();
const VITE_DEV_SERVER_ORIGIN = process.env.VITE_DEV_SERVER_ORIGIN ?? "http://localhost:5173";

// Global error handler — log + capture unhandled exceptions so they reach
// both Railway logs and PostHog error tracking (same pane as client errors).
app.onError((err, c) => {
  const queryTimeout = findDatabaseQueryTimeout(err);
  if (queryTimeout) {
    return c.json({ error: "Database response timed out. Refresh to check whether the operation completed.",
      code: queryTimeout.code, outcome: queryTimeout.outcome }, 503);
  }
  // Client-caused request failures are not server errors — answer 400 and keep
  // them out of error tracking (they were ~300 captured "500s" per 14d, all
  // truncated/aborted uploads on the state PATCH when the tab closed mid-save):
  //  - a body that stopped arriving ("aborted" — nobody is listening for the
  //    response anyway)
  //  - a truncated/malformed JSON body (c.req.json() SyntaxError)
  if (err.message === "aborted") {
    return c.json({ error: "Request aborted" }, 400);
  }
  if (err instanceof SyntaxError && /JSON/i.test(err.message)) {
    console.warn(`[400] ${c.req.method} ${c.req.path}: malformed JSON body (${err.message})`);
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  console.error(`[ERROR] ${c.req.method} ${c.req.path}:`, err.message, err.stack);
  captureServerError("hono-onerror", err, { path: c.req.path, method: c.req.method });
  return c.json(
    IS_DEV || isTestingRequest(c.req.url, c.req.raw.headers)
      ? { error: "Internal Server Error", detail: err.message }
      : { error: "Internal Server Error" },
    500,
  );
});

// Deduplicate expensive plan/entitlement resolution within a single request.
app.use("/api/*", async (_c, next) => runWithRequestCache(next));

// Request timing — every slow API request (>1s) plus a 1% sample of the rest
// goes to PostHog as `server_request`, keyed by ROUTE PATTERN (not raw path,
// which would explode event cardinality with ids). SSE responses are skipped:
// their duration is the generation's lifetime, not server latency. This is the
// data that answers "did the deploy make p95 worse?" without grepping logs.
app.use("/api/*", async (c, next) => {
  const start = Date.now();
  await next();
  const durationMs = Date.now() - start;
  if (c.res.headers.get("content-type")?.includes("text/event-stream")) return;
  const slow = durationMs > 1_000;
  if (slow || Math.random() < 0.01) {
    // The root app is an untyped Hono(); auth middleware sets "user" downstream.
    const user = c.get("user" as never) as { id: string } | undefined;
    posthog.capture({
      distinctId: user?.id ?? "server",
      event: "server_request",
      properties: {
        ...runtimeIdentity,
        route: c.req.routePath || c.req.path,
        method: c.req.method,
        status: c.res.status,
        duration_ms: durationMs,
        slow,
      },
    });
  }
});

// Compress API responses (gzip) — reduces bandwidth 60-80% between Railway and Cloudflare.
// SSE streams handle their own chunked encoding so they're excluded via content-type check.
// Auth routes are excluded: compression clones the Response, and Node.js Response cloning
// can silently drop Set-Cookie headers — the cookie that keeps users logged in.
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth")) return next();
  const middleware = compress();
  return middleware(c, next);
});

// Global middleware — CORS for API routes only.
// Static assets (/assets/*, /sandbox/*, /cdn/*) set their own CORS headers
// because the sandbox iframe has an opaque origin that doesn't match APP_URL.
app.use("/api/*", corsMiddleware);
app.use("/api/*", privateStateCache);
app.use("/health", corsMiddleware);

// Global body size limit — reject payloads over 5 MB before route handlers parse them.
// S3 uploads bypass this (client uploads directly to S3 via presigned URLs).
// Stripe webhooks need raw body parsing so they get a generous limit too.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/stripe/webhook")) return next();
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > 5 * 1024 * 1024) {
    return c.json({ error: "Request body too large (max 5 MB)" }, 413);
  }
  return next();
});

// Legacy cookie cleanup removed 2026-05-15 (was scheduled for ~2026-05-17).
// All active users have had their old __Secure-better-auth.* cookies expired.

// Read-after-write consistency: flag users who just wrote so their reads use primary DB
app.use("/api/*", async (c, next) => {
  await next();
    if (c.res.ok && !c.req.path.startsWith("/api/engagement/") && (c.req.method === "POST" || c.req.method === "PATCH" || c.req.method === "DELETE")) {
    try {
      const u = c.get("user" as never) as { id: string } | undefined;
      if (u?.id) void flagWrite(u.id);
    } catch { /* no user context — skip */ }
  }
});

// Routes
app.route("/health", health);
if (IS_DEV || !env.DATABASE_URL) app.route("/api/dev", devRoutes);
app.route("/api/auth", authRoutes);
// The edition descriptor is public: a logged-out browser reads it to decide
// between a login screen and single-user auto sign-in.
app.route("/api/edition", editionRoutes);
app.route("/api/local-auth", localAuthRoutes);
app.route("/api/users", users);
app.route("/api/worlds", worldRoutes);
app.route("/api/keys", apiKeyRoutes);
app.route("/api/sessions", sessionRoutes);
app.route("/api/sessions", sessionMemoryRoutes);
app.route("/api/sessions", stateGuardRoutes);
app.route("/api/combat", combatRoutes);
// Hosted routers with public reads, webhooks or guest beacons MUST precede
// messageRoutes' broad "/api/*" authMiddleware. The edition owns that list
// (see edition/hosted.ts for the per-router reasons); the local edition
// mounts nothing here.
edition.mountPublicApiRoutes(app);
// Extensions: the first-party session-memory extension is installed and toggled
// through this router, so it is core. Its browse/detail reads are public and
// must precede messageRoutes' broad auth middleware.
app.route("/api/extensions", extensionRoutes);
app.route("/api", messageRoutes);
app.route("/api", completionRoutes);
app.route("/api/sessions", socialSimulatorRoutes);
app.route("/api/studio", studioRoutes);
app.route("/api/studio", agentRoutes);
app.route("/api", assetRoutes);
app.route("/api/user-prompts", userPromptsRoutes);
app.route("/api/user-preset-overrides", userPresetOverridesRoutes);
app.route("/api/user-assets", userAssetRoutes);
app.route("/api", assetRefRoutes);
app.route("/api", folderBindingRoutes);
app.route("/api/personas", personaRoutes);
// Everything else the hosted platform serves (social, billing, admin, ...).
edition.mountApiRoutes(app);

// Browsers auto-probe /favicon.ico even though index.html links the PNG icons.
// With no file at ./public/favicon.ico the request falls through to the SPA
// catch-all and returns the HTML shell (text/html, no-store, hits LA origin) on
// every visit. Redirect it to a real icon (301 is itself edge-cacheable).
app.get("/favicon.ico", (c) => c.redirect("/favicon-32.png", 301));

// Public CDN proxy — no auth, permanent URLs for assets
// CORS: sandbox iframe (opaque origin) needs this to load images/fonts via JS
app.use("/cdn/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
});
app.route("/cdn", cdnRoutes);

// On-disk storage upload target (local edition / dev without S3). Lives outside
// /api so the 5 MB API body cap and the auth middleware do not apply; the URL
// itself carries a signed, expiring token (see routes/storage.ts).
app.route("/storage", storageRoutes);

// Sitemap, first-party game pages and other hosted-only root surfaces.
edition.mountRootRoutes(app);

// Serve static frontend in production
if (process.env.NODE_ENV === "production") {
  const indexHtml = fs.existsSync("./public/index.html")
    ? fs.readFileSync("./public/index.html", "utf-8")
    : null;

  // Sandbox CSP — the iframe has an opaque origin (sandbox="allow-scripts"
  // without allow-same-origin), so 'self' = null. Use https: to allow loading
  // scripts/CSS from the parent domain. The real security boundary is the
  // iframe sandbox attribute + connect-src 'none'.
  //
  // frame-src: allowlist of common static-hosting platforms that trusted card
  // authors can use to embed their own apps (e.g. Pokemon battle iframe on
  // *.pages.dev). These hosts all require account creation + have abuse
  // detection, so they're higher-trust than arbitrary https:. Expand this list
  // only when a specific card needs a new platform.
  const SANDBOX_CSP = [
    "default-src https: 'unsafe-inline' 'unsafe-eval'",
    "img-src https: data: blob:",
    "font-src https: data:",
    "connect-src 'none'",
    "frame-src https://*.pages.dev https://*.vercel.app https://*.netlify.app https://*.github.io",
    // Only the app itself may embed the sandbox document. If the sandbox
    // ever moves to a dedicated origin (VITE_SANDBOX_URL), this must
    // become the app origin explicitly (e.g. https://yumina.io).
    "frame-ancestors 'self'",
  ].join("; ");

  /** The build emits the sandbox document twice: at its authored path and, so
   *  Cloudflare's /assets/* rule can cache it, under a content hash. The hashed
   *  copy executes the same untrusted card code, so it needs the same policy —
   *  a document that lands there without this header would run UGC with the
   *  sandbox's restrictions quietly missing. Kept as a prefix match rather than
   *  a blanket /assets/*.html rule so a future HTML asset must opt in. */
  const isSandboxDoc = (path: string) =>
    path.startsWith("/sandbox/") || path.startsWith("/assets/sandbox-doc-");

  app.use("/sandbox/*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", SANDBOX_CSP);
    c.header("Cache-Control", "no-store");
    // CORS — opaque-origin iframe needs explicit permission to load ES modules
    c.header("Access-Control-Allow-Origin", "*");
  });

  // The hashed sandbox document is load-bearing for every custom-UI card, and a
  // deploy that ships a pointer naming a hash the public dir does not hold turns
  // ALL of them into 40-second "couldn't load this world's interface" failures
  // (2026-09-01 outage: origin 404 on sandbox-doc-653c633b.html while cached
  // pointer chunks still referenced it -- desktops on cold Cloudflare colos died
  // platform-wide, phones rode two-day-old edge copies). The document is
  // version-tolerant by design -- the authored path IS the retry fallback -- so
  // an unknown hash serves the authored document instead of a 404: stale tabs,
  // stale pointers, cold colos and future pipeline misses all heal. Short-cached,
  // never immutable: the alias answer is a stand-in. (A middleware, not a route
  // param -- hono cannot match "sandbox-doc-:rest" inside one segment, which a
  // local app.request() proved by never matching at all.)
  app.use("/assets/*", async (c, next) => {
    const reqPath = c.req.path;
    if (!/^\/assets\/sandbox-doc-[A-Za-z0-9]+\.html$/.test(reqPath)) return next();
    if (fs.existsSync("./public" + reqPath)) return next(); // the real, immutable file
    const fallback = "./public/sandbox/index.html";
    if (!fs.existsSync(fallback)) return next();
    console.warn(`[sandbox-doc] alias: ${reqPath} not on disk -- serving the authored document`);
    const body = await fs.promises.readFile(fallback);
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300");
    c.header("CDN-Cache-Control", "public, max-age=300");
    c.header("Content-Security-Policy", SANDBOX_CSP);
    c.header("Access-Control-Allow-Origin", "*");
    return c.body(body);
  });

  // Cache-Control for hashed static assets (immutable on 200, no-store on 404)
  // CORS — sandbox iframe (opaque origin) needs this to load JS/CSS modules
  // CRITICAL: only set immutable on 200. A 404 with immutable headers gets cached
  // by Cloudflare's edge for a year, poisoning old chunk URLs after every deploy.
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.status === 200) {
      // The sandbox-doc route above sets its own Cache-Control: immutable for
      // a real on-disk hash, short-cache for the authored stand-in. Stomping
      // it here would let a browser pin the stand-in for a year under an old
      // hashed URL — re-creating the stale-doc outage one layer deeper.
      if (!isSandboxDoc(c.req.path)) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    } else {
      c.header("Cache-Control", "no-store");
    }
    c.header("Access-Control-Allow-Origin", "*");
    if (isSandboxDoc(c.req.path)) c.header("Content-Security-Policy", SANDBOX_CSP);
  });

  // Cache static images (wallpapers, hero, logo) for 1 day with revalidation
  app.use("/*.jpg", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) {
      c.header("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    }
  });
  app.use("/*.png", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) {
      c.header("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    }
  });

  // Ensure HTML served directly by serveStatic (e.g. root "/" → index.html) gets
  // no-cache headers so Cloudflare and browsers never serve stale index.html after
  // a deploy (which references now-deleted chunk hashes).
  app.use("/*", async (c, next) => {
    await next();
    const ct = c.res.headers.get("Content-Type") ?? "";
    if (ct.includes("text/html") && !c.res.headers.has("Cache-Control")) {
      c.header("Cache-Control", "no-store, no-cache, must-revalidate");
      c.header("CDN-Cache-Control", "no-store");
    }
  });
  app.use("/*", serveStatic({
    root: "./public",
    // Set Cache-Control DURING serving (onFound) so it sticks. A post-next() header
    // on serveStatic's finalized response does NOT apply — which is why public/ images
    // (wallpaper, logos, hero) went out with no Cache-Control and Cloudflare marked
    // them DYNAMIC, sending every image to the LA origin. HTML stays no-store so SPA
    // deploys never serve a stale index.html. (2026-06-05 wallpaper/asset-cache fix.)
    onFound: (path, c) => {
      // Everything under /assets/ is content-hashed, .html included: the build
      // emits the sandbox document as assets/sandbox-doc-<hash>.html precisely
      // so it can live here. It is as immutable as the JS chunks beside it and
      // must NOT fall into the SPA-shell no-store branch below — that is what
      // makes the edge serve it, which removes an origin round trip from every
      // custom-UI card load and keeps old hashes reachable for tabs that were
      // already open when a deploy landed. Without it the document comes back
      // cf-cache-status: DYNAMIC, 503s for the length of a deploy swap, and the
      // iframe's ready handshake never arrives (2026-08-25 "ALLDAY PROJECT
      // 一直显示载入"; still happening 2026-08-29 because the fix landed on an
      // /assets/index-<hash>.html that no code ever requested).
      const isHashedAsset = c.req.path.startsWith("/assets/");
      if (!isHashedAsset && (path.endsWith(".html") || path.endsWith("sw.js"))) {
        c.header("Cache-Control", "no-store, no-cache, must-revalidate");
        c.header("CDN-Cache-Control", "no-store");
      } else {
        // Browser: revalidate within a day, so a replaced (non-hashed) asset like
        // a wallpaper/logo/hero is picked up soon. Edge (Cloudflare honors
        // CDN-Cache-Control over Cache-Control): hold for a year so the single LA
        // origin isn't re-hit — serveStatic emits no ETag/Last-Modified, so every
        // edge revalidation would otherwise be a full re-download from LA.
        // NOTE: only takes effect once a CF cache rule makes these root static
        // paths (/hub/*, /wallpaper*, /favicon-*, …) eligible — today they return
        // cf-cache-status: DYNAMIC because a CF rule only caches /assets/* + /cdn/*.
        c.header("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
        c.header("CDN-Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));

  // SPA fallback — serve index.html with route-specific meta tags for SEO
  if (indexHtml) {
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/sandbox")) return c.notFound();
      if (c.req.path.startsWith("/assets/")) return c.notFound();

      let html = indexHtml;
      try {
        const meta = await getMetaForPath(c.req.path);
        html = injectMeta(indexHtml, meta);
      } catch {
        // Meta injection failed — serve unmodified HTML
      }

      c.header("Cache-Control", "no-store, no-cache, must-revalidate");
      c.header("CDN-Cache-Control", "no-store");
      c.header("Surrogate-Control", "no-store");
      return c.html(html);
    });
  }
} else {
  const proxyToVite = async (c: Context) => {
    const incoming = new URL(c.req.url);

    // Vite HMR tries to open a WebSocket via `Connection: upgrade` + `Upgrade: websocket`.
    // Regular `fetch()` can't do protocol upgrades, and undici throws on any `upgrade` header.
    // Short-circuit WS upgrade requests so they fail cleanly on the client instead of
    // spamming the server log. Vite's HMR client falls back to reconnecting on :5173 directly.
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return c.text("Vite HMR WebSocket must connect to the Vite dev server directly.", 426);
    }

    const target = new URL(`${incoming.pathname}${incoming.search}`, VITE_DEV_SERVER_ORIGIN);
    const headers = new Headers(c.req.raw.headers);

    headers.set("host", target.host);
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
    headers.delete("connection");
    headers.delete("content-length");
    // Defense-in-depth: strip anything upgrade-related so fetch() never sees them.
    headers.delete("upgrade");
    headers.delete("sec-websocket-key");
    headers.delete("sec-websocket-version");
    headers.delete("sec-websocket-extensions");
    headers.delete("sec-websocket-protocol");

    const body =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? undefined
        : await c.req.arrayBuffer();

    try {
      const response = await fetch(target, {
        method: c.req.method,
        headers,
        body,
        redirect: "manual",
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      console.error("[DEV PROXY] Failed to reach Vite dev server:", error);
      return c.html(
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Yumina Dev Proxy</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background:#111; color:#f5f5f5; padding:2rem; line-height:1.6; }
      code { background:#1f1f1f; padding:0.15rem 0.35rem; border-radius:0.35rem; }
    </style>
  </head>
  <body>
    <h1>Vite dev server is not running</h1>
    <p>Start the live-reload stack with <code>corepack pnpm dev:3000</code>.</p>
    <p>The backend API is running, but frontend requests from <code>localhost:${env.PORT}</code> are proxied to <code>${VITE_DEV_SERVER_ORIGIN}</code> in development.</p>
  </body>
</html>`,
        503
      );
    }
  };

  app.all("*", proxyToVite);
}

// ── Schema self-heal (post-listen) ───────────────────────────────────────────
// The ensure* DDL suite is a SAFETY NET behind the DB-before-code policy
// (CLAUDE.md): schema changes are applied to the target database manually
// BEFORE the code that needs them deploys. It must never run in the boot path
// of a zero-downtime deploy: even a no-op `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS` takes an ACCESS EXCLUSIVE lock, and while the OLD replicas are still
// serving queries that lock is unobtainable on hot tables — both new replicas
// crashed before binding their port (2026-06-11 deploy failure; the role-level
// lock_timeout=20s turned the lock wait into a startup throw). The server now
// binds first and the heal runs once the deploy swap has settled: Railway
// stops the old replicas seconds after the new ones pass their healthcheck,
// after which the same DDL completes in milliseconds on idle tables.
const SELF_HEAL_ATTEMPT_DELAYS_MS = process.env.NODE_ENV === "production"
  ? [90_000, 180_000, 420_000, 900_000]
  : [1_000, 60_000, 180_000];

async function runSchemaSelfHealOnce(): Promise<void> {
  await ensureTables();
  await ensureLifetimePlaytimePending();
  await ensureWorldsSchemaDerived();
  await ensureMessagesSwipeCount();
  await ensureWorldReviewControlsColumn();
  await ensureSessionPersonaColumn();
  await ensureWorldReviewTables();
  await ensureJwksTable();
  await ensurePlatformAchievementTables();
  await seedPlatformAchievements();
  await ensureWorldTagsConstraint();
  await ensureBundleTagsConstraint();
  await ensureSessionContextColumns();
  await ensureCommunityEventTables();
  await ensureCommunityImageColumns();
  await ensureCommunityOfficialColumn();
  await ensureCheckInTables();
  await ensureBillingV2Schema();
  await ensureQuestBoardSchema();
  await ensureTranslationAttemptsTable();
  await ensureProfileWallTable();
  await ensureDmSchema();
  await ensureExtensionTables();
  await ensureScheduledFunctions();
  await ensureAnalyticsRollupTables();
  // Flip account-deletion readiness only after every table touched by the
  // atomic cleanup/counter reconciliation above exists.
  await ensureAccountDeletionForeignKeys();
  // Hot-path indexes (CONCURRENTLY, leader-only) — see db/index.ts.
  await ensureHotPathIndexes();

  // Sync status column for worlds published before migration 0011 (idempotent
  // data heal — rides the same retry schedule as the DDL above).
  const r = await db.execute(sql`UPDATE worlds SET status = 'published' WHERE is_published = true AND status = 'draft'`);
  const count = (r as any).rowCount ?? 0;
  if (count > 0) console.log(`[STARTUP] Synced status for ${count} published worlds`);
}

function scheduleSchemaSelfHeal(): void {
  let attempt = 0;
  const tryOnce = async () => {
    attempt += 1;
    try {
      const t0 = Date.now();
      await withDatabaseQueryTimeout(300_000, runSchemaSelfHealOnce);
      console.log(`[STARTUP] Schema self-heal complete in ${Date.now() - t0}ms (attempt ${attempt})`);
    } catch (err) {
      console.error(`[STARTUP] Schema self-heal attempt ${attempt} failed:`, err instanceof Error ? err.message : err);
      const delay = SELF_HEAL_ATTEMPT_DELAYS_MS[attempt];
      if (delay !== undefined) {
        console.log(`[STARTUP] Retrying schema self-heal in ${Math.round(delay / 1000)}s`);
        setTimeout(() => { void tryOnce(); }, delay).unref();
      } else {
        // The net failed — the schema may genuinely be behind the code. That is
        // a DB-before-code policy violation to fix by running the pending DDL
        // manually; the server stays up and serving either way.
        captureServerError("startupSelfHeal", err);
        console.error("[STARTUP] Schema self-heal gave up — apply pending DDL manually (DB-before-code policy)");
      }
    }
  };
  setTimeout(() => { void tryOnce(); }, SELF_HEAL_ATTEMPT_DELAYS_MS[0]).unref();
}

// Bootstrap: bind the port first; the schema self-heal runs post-listen (see
// above). PGlite is the exception — the embedded DB starts empty and has no
// concurrent old deployment to contend with, so it heals synchronously
// before serving.
async function start() {
  if (!env.DATABASE_URL) {
    // Empty embedded database: create the schema first, then let the
    // self-heal suite bring it to parity (see db/bootstrap-pglite.ts).
    await bootstrapPgliteSchema();
    await runSchemaSelfHealOnce();
  }

  // (2026-06-01) Hub Translation (multilanguage_overview) is retired — superseded
  // by per-language variants + the 主/副 model. The former startup migrations
  // (migrateVariantOverviews / reconcileMloAnnouncementWithColumn, and their
  // migrate-multilanguage.ts module) re-seeded that column from siblings on every
  // boot; both are deleted so the column stays dead. The hub no longer reads it;
  // the nullable column is kept only until a later drop-column pass.

  // Connect Redis (no-op if REDIS_URL not set)
  await connectRedis();
  // Interval jobs, cache prewarms and leader-elected sweeps belong to the
  // edition (hosted: recommendations, payouts, rollups, image generation, ...;
  // local: nothing).
  edition.startBackgroundJobs();

  // Load the cl100k_base ranks up front so token budgeting is exact from the
  // first request. estimateTokens falls back to a char heuristic until the
  // ranks resolve (they moved to a lazy import so the editor bundle no longer
  // ships 5.5 MB of rank data — see engine/prompts/token-utils.ts).
  preloadTokenizer()
    .then(() => console.log("[STARTUP] Tokenizer ranks loaded"))
    .catch(() => {});

  const server = serve(
    {
      fetch: app.fetch,
      port: env.PORT,
      ...(BIND_HOST ? { hostname: BIND_HOST } : {}),
    },
    (info) => {
      console.log(`Yumina server (${edition.name} edition) running on http://${BIND_HOST ?? "localhost"}:${info.port}`);
      console.log(`[STARTUP] features: bundle-likes`);
      if (env.RUNTIME_CPU_PROFILE_SECONDS > 0) {
        void captureBoundedCpuProfile(env.RUNTIME_CPU_PROFILE_SECONDS * 1000)
          .then(profile => console.log(`[CPU_PROFILE] ${JSON.stringify({ ...runtimeIdentity, ...profile })}`))
          .catch(error => captureServerError("cpu-profile", error));
      }
    }
  );

  // Real Postgres: heal the schema in the background now that the port is
  // bound and the healthcheck can pass.
  if (env.DATABASE_URL) {
    scheduleSchemaSelfHeal();
  }
  edition.afterListen();

  // Graceful shutdown — drain in-flight generations before exiting.
  // Railway's web service drainingSeconds is 90 (.railway/railway.ts).
  // Allow 50s for natural completion and 10s for aborted handlers to persist
  // their checkpoints before process.exit; the remainder covers other cleanup.
  // Abort stragglers with a distinct shutdown reason —
  // handlers log their usage and send the client a clean SERVER_RESTART error
  // instead of a dead connection (see lib/stream-registry.ts).
  process.on("SIGTERM", async () => {
    stopRuntimeMonitor();
    console.log(`[SHUTDOWN] SIGTERM received, draining ${activeStreamCount()} active generation(s)...`);
    // Stop the in-process daily-recovery interval first so its handle no
    // longer keeps the event loop alive once we've finished other cleanup.
    // Without this, process.exit(0) would still work but Node would log
    // "still running" warnings during deploys.
    edition.stopBackgroundJobs();
    stopRateLimitCleanup();
    server.close();
    const [{ finishedNaturally, abortedCount }] = await Promise.all([
      drainStreams(50_000, 10_000), edition.drain(50_000),
    ]);
    console.log(
      finishedNaturally
        ? "[SHUTDOWN] All generations completed naturally"
        : `[SHUTDOWN] Drain deadline hit — aborted ${abortedCount} straggler(s) cleanly`,
    );
    await disconnectRedis();
    await posthog.shutdown();
    console.log("[SHUTDOWN] Clean exit");
    process.exit(0);
  });
}

start();

// Export app type for Hono RPC client
export type AppType = typeof app;
