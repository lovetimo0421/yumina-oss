import { Hono } from "hono";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { isS3Configured, getObject } from "../lib/s3.js";
import { Readable } from "node:stream";

// In-memory LRU cache: assetId → s3Key
// Assets are immutable, so the mapping never changes.
const S3_KEY_CACHE_MAX = 10_000;
const s3KeyCache = new Map<string, string>();

function getCachedS3Key(assetId: string): string | undefined {
  const value = s3KeyCache.get(assetId);
  if (value !== undefined) {
    // Move to end (most recently used) by re-inserting
    s3KeyCache.delete(assetId);
    s3KeyCache.set(assetId, value);
  }
  return value;
}

function setCachedS3Key(assetId: string, s3Key: string): void {
  // Evict oldest entry if at capacity
  if (s3KeyCache.size >= S3_KEY_CACHE_MAX) {
    const oldest = s3KeyCache.keys().next().value!;
    s3KeyCache.delete(oldest);
  }
  s3KeyCache.set(assetId, s3Key);
}

const cdnRoutes = new Hono();

// Allowed S3 key prefixes (defense-in-depth against arbitrary key access)
const ALLOWED_KEY_PREFIXES = ["worlds/", "reports/", "studio-chat/", "users/", "bundles/", "dm/", "community/"];

/**
 * CORS for the public asset route.
 *
 * The card sandbox is an `allow-scripts` iframe with an OPAQUE origin, so every
 * request it makes here is cross-origin. Plain `<img>` display never needed
 * this — the browser paints a cross-origin image happily. But a WebGL texture
 * upload does: `texImage2D` refuses a non-origin-clean image, and three.js's
 * loaders request with `crossOrigin="anonymous"`. Without this header a 3D card
 * simply cannot use anything from the asset library, which is why every 3D card
 * so far has had to generate its textures in code.
 *
 * Safe to open: this route is already public and unauthenticated — anyone can
 * `curl` these bytes today. `*` only adds *scripted* cross-origin reads of data
 * that was never protected. It must NOT be widened to reflect an Origin with
 * credentials, and this route must never start honoring cookies.
 */
function applyCdnCors(c: Context): void {
  c.header("Access-Control-Allow-Origin", "*");
  // Media seeking + progress UIs need these readable cross-origin; without the
  // allowlist the browser hides them from script even on a successful response.
  c.header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag");
  // `Vary: Origin` is deliberately omitted: the value is a constant `*`, so
  // varying would only fragment the Cloudflare cache for no behavioral gain.
}

// Range is only CORS-safelisted for simple `bytes=a-b` forms, so media players
// issuing anything richer will preflight. Answer it here rather than 404-ing.
cdnRoutes.options("/*", (c) => {
  applyCdnCors(c);
  c.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Range, Content-Type");
  c.header("Access-Control-Max-Age", "86400");
  return c.body(null, 204);
});

// GET /cdn/key/:encodedKey — public, permanent URL for raw S3 keys
// Used for thumbnails, gallery images, user avatars that don't have asset table entries.
// The key is base64url-encoded to be URL-safe.
cdnRoutes.get("/key/:encodedKey", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const encodedKey = c.req.param("encodedKey");

  let s3Key: string;
  try {
    s3Key = Buffer.from(encodedKey, "base64url").toString("utf-8");
  } catch {
    return c.json({ error: "Invalid key encoding" }, 400);
  }

  if (!s3Key || s3Key.includes("..") || !s3Key.includes("/")) {
    return c.json({ error: "Invalid key" }, 400);
  }

  if (!ALLOWED_KEY_PREFIXES.some((p) => s3Key.startsWith(p))) {
    return c.json({ error: "Invalid key prefix" }, 400);
  }

  return streamS3Object(c, s3Key, "CDN key proxy error:");
});

/**
 * Stream an S3 object through, honoring Range requests (audio/video seeks no
 * longer re-download from byte zero — S3 itself slices and answers 206 with
 * Content-Range; we forward both ways verbatim). Accept-Ranges advertises
 * support so players issue ranged requests at all.
 */
export async function streamS3Object(
  c: Context,
  s3Key: string,
  errorLogPrefix: string,
): Promise<Response> {
  const range = c.req.header("range");
  try {
    const { body, contentType, contentLength, contentRange, etag } = await getObject(
      s3Key,
      range ? { range } : undefined,
    );

    if (!body) {
      return c.json({ error: "Asset body empty" }, 502);
    }

    applyCdnCors(c);
    c.header("Content-Type", contentType);
    // User-owned objects can be removed during account deletion. Browsers must
    // revalidate instead of keeping an immutable one-year copy; the edge may
    // cache briefly for performance, bounding post-deletion availability.
    //
    // Cloudflare answers this policy with `warning: cf-images 299
    // "cache-control is too restrictive"` — it cannot hold the resized variants
    // it builds, so thumbnail grids re-derive on every visit. Relaxing the TTL
    // only for the resizing subrequest needs a signal a client cannot forge:
    // `Via: image-resizing` is attacker-settable on this public route, and the
    // long-lived response would then be cached under that URL for everyone.
    // Doing it safely means a Cloudflare-side rule (strip inbound Via, or set a
    // secret header), so it stays out of this change.
    c.header("Cache-Control", "public, max-age=0, s-maxage=300, must-revalidate");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Accept-Ranges", "bytes");
    if (etag) c.header("ETag", etag);
    if (contentLength != null) {
      c.header("Content-Length", String(contentLength));
    }
    let status = 200;
    if (range && contentRange) {
      c.header("Content-Range", contentRange);
      status = 206;
    }

    const stream = body instanceof Readable ? (Readable.toWeb(body) as ReadableStream) : (body as ReadableStream);
    return new Response(stream, { status, headers: c.res.headers });
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      return c.json({ error: "Asset file not found in storage" }, 404);
    }
    // An unsatisfiable range (seek past EOF) comes back from S3 as 416.
    if (err?.$metadata?.httpStatusCode === 416) {
      return c.json({ error: "Requested range not satisfiable" }, 416);
    }
    console.error(errorLogPrefix, err);
    return c.json({ error: "Failed to fetch asset" }, 502);
  }
}

// GET /cdn/:assetId — public, permanent URL for any asset
// No auth required — UUID is unguessable. CDN-friendly cache headers.
cdnRoutes.get("/:assetId", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const assetId = c.req.param("assetId");

  // Check in-memory cache first
  let s3Key: string | null = getCachedS3Key(assetId) ?? null;

  if (!s3Key) {
    // Single query across both tables
    const result = await db.execute(sql`
      SELECT url FROM assets WHERE id = ${assetId}
      UNION ALL
      SELECT url FROM user_assets WHERE id = ${assetId}
      LIMIT 1
    `);

    const rows = result.rows as Array<{ url: string }>;
    if (rows.length > 0) {
      s3Key = rows[0]!.url;
      setCachedS3Key(assetId, s3Key);
    }
  }

  if (!s3Key) {
    return c.json({ error: "Asset not found" }, 404);
  }

  return streamS3Object(c, s3Key, "CDN proxy error:");
});

export { cdnRoutes };
