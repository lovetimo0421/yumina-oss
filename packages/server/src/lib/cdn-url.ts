/**
 * Shared CDN URL resolution for images and assets.
 *
 * Converts raw S3 keys into deterministic `/cdn/key/...` URLs that
 * Cloudflare can cache. Replaces all the async `resolveImage()` /
 * `resolveThumbnail()` functions that generated presigned S3 URLs.
 */
import { PUBLIC_ORIGIN } from "./env.js";

/** Get the origin URL for absolute CDN paths */
function getOrigin(): string {
  return PUBLIC_ORIGIN;
}

/**
 * Resolve an S3 key or existing URL for CDN serving.
 * - null/empty → null
 * - Starts with "http" → returned as-is (external URL or legacy presigned URL)
 * - Otherwise → treated as S3 key, encoded into absolute CDN URL
 *
 * Returns ABSOLUTE URLs (e.g., https://yumina.io/cdn/key/...) so they work
 * in custom components that parse URLs with `new URL(imageUrl)`.
 *
 * Synchronous — pure string manipulation, zero I/O.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_REF_RE = /^@asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function resolveImageCdn(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return null;
  // @asset:UUID references → extract the UUID and route to /cdn/:assetId
  const assetMatch = ASSET_REF_RE.exec(url);
  if (assetMatch) return `${getOrigin()}/cdn/${assetMatch[1]}`;
  // Bare asset IDs (UUIDs) → /cdn/:assetId (DB lookup for S3 key)
  if (UUID_RE.test(url)) return `${getOrigin()}/cdn/${url}`;
  // S3 keys (e.g. "worlds/abc.jpg") → /cdn/key/:encodedKey
  return `${getOrigin()}/cdn/key/${Buffer.from(url, "utf-8").toString("base64url")}`;
}
