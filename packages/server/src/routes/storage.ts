/**
 * /storage — the local-disk stand-in for a presigned S3 PUT.
 *
 * In local mode `generateUploadUrl()` hands the browser
 * `${PUBLIC_ORIGIN}/storage/upload?token=…`; the browser then PUTs the raw
 * file body here exactly as it would to S3 (cross-origin in dev, no cookies).
 * The token — HMAC-signed with the auth secret, 1 h expiry — carries the key
 * and content type and is the whole authorization, so this route runs with
 * no auth middleware and never reads a cookie.
 *
 * Mounted at `/storage`, outside `/api/*`, so the 5 MB API body cap does not
 * apply; the ceiling here is YUMINA_MAX_UPLOAD_MB (default 512 MB).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getLocalDiskStorage, storageKind, verifyUploadToken } from "../lib/s3.js";
import { storageErrorStatus } from "../lib/storage/local-disk.js";

export const storageRoutes = new Hono();

function allowAnyOrigin(c: Context): void {
  c.header("Access-Control-Allow-Origin", "*");
}

/** "image/png; charset=x" -> "image" */
function topLevelType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase().split("/")[0] ?? "";
}

storageRoutes.options("/upload", (c) => {
  allowAnyOrigin(c);
  c.header("Access-Control-Allow-Methods", "PUT, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  c.header("Access-Control-Max-Age", "86400");
  return c.body(null, 204);
});

storageRoutes.put("/upload", async (c) => {
  allowAnyOrigin(c);
  if (storageKind() !== "local") return c.json({ error: "Not found" }, 404);

  const token = c.req.query("token");
  const claims = token ? verifyUploadToken(token) : null;
  if (!claims) return c.json({ error: "Invalid or expired upload token" }, 403);

  // The token is authoritative for the stored content type. The header is only
  // sanity-checked at the top level so a token for image/* cannot be used to
  // park text/html under an image key.
  const headerType = c.req.header("content-type");
  if (headerType && topLevelType(headerType) !== topLevelType(claims.contentType)) {
    return c.json({ error: "Content-Type does not match the upload token" }, 400);
  }

  const storage = getLocalDiskStorage();
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > storage.maxUploadBytes) {
    return c.json({ error: "Upload too large" }, 413);
  }

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Missing request body" }, 400);

  try {
    const { size } = await storage.writeFromStream(claims.key, claims.contentType, body);
    return c.json({ ok: true, key: claims.key, size });
  } catch (err) {
    const status = storageErrorStatus(err);
    if (status === 413) return c.json({ error: "Upload too large" }, 413);
    if (status === 400) return c.json({ error: "Invalid upload key" }, 400);
    console.error("[storage] upload failed:", err);
    return c.json({ error: "Upload failed" }, 500);
  }
});
