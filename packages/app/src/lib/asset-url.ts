// `import.meta.env` is injected by Vite at build time; guard the access so the
// module can also be imported in non-Vite contexts (Node test runner, SSR)
// without throwing at load.
const apiBase = import.meta.env?.VITE_API_URL || "";

/** Get the permanent public CDN URL for an asset by ID (always full URL) */
export function getAssetCdnUrl(assetId: string): string {
  const base = apiBase || (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/cdn/${assetId}`;
}

function cdnBase(): string {
  return apiBase || (typeof window !== "undefined" ? window.location.origin : "");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_REF_RE =
  /^@asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** UTF-8 → base64url, matching Node's `Buffer.from(s, "utf-8").toString("base64url")`
 *  so the encoded key round-trips through the server's `/cdn/key/:encodedKey` route. */
function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Resolve a stored image reference (user/creator avatars, thumbnails, gallery
 * images) into a usable CDN URL. Synchronous mirror of the server's
 * `resolveImageCdn` so any endpoint that returns a raw S3 key still renders.
 *
 * Idempotent: already-resolved `http(s)`/`/cdn`/`data:`/`blob:` values pass
 * through unchanged, so resolving twice (server + here) is safe.
 * - null/empty            → undefined (lets <img>/Avatar fall back)
 * - http(s):// | /cdn/... → as-is
 * - data: | blob:         → as-is (local previews)
 * - @asset:{uuid}         → `/cdn/{uuid}`
 * - bare {uuid}           → `/cdn/{uuid}`
 * - raw S3 key            → `/cdn/key/{base64url}`
 */
export function resolveImageUrl(
  ref: string | null | undefined,
): string | undefined {
  if (!ref) return undefined;
  if (
    ref.startsWith("http") ||
    ref.startsWith("/cdn") ||
    ref.startsWith("data:") ||
    ref.startsWith("blob:")
  ) {
    return ref;
  }
  const assetMatch = ASSET_REF_RE.exec(ref);
  if (assetMatch) return `${cdnBase()}/cdn/${assetMatch[1]}`;
  if (UUID_RE.test(ref)) return `${cdnBase()}/cdn/${ref}`;
  return `${cdnBase()}/cdn/key/${toBase64Url(ref)}`;
}

/**
 * Absolute variant of `resolveImageUrl` for cross-origin consumers — values
 * pushed into the sandbox iframe resolve root-relative `/cdn/...` against the
 * SANDBOX origin (wrong host → broken image), so prefix the app origin here.
 */
export function absoluteImageUrl(ref: string | null | undefined): string | null {
  const url = resolveImageUrl(ref);
  if (!url) return null;
  return url.startsWith("/") ? `${cdnBase()}${url}` : url;
}

/**
 * Edge-resized variant of a CDN image for card/grid rendering, via Cloudflare
 * Image Transformations (`/cdn-cgi/image/<options>/<same-zone-path>`).
 *
 * Cards render at ~400px but originals run 150–300KB+ (measured live
 * 2026-06-10); a sized `format=auto` variant is ~30–60KB. `onerror=redirect`
 * makes the edge serve the ORIGINAL whenever a transform fails (unsupported
 * format, oversize source), and <CroppedImage> keeps a client-side onError
 * fallback for the feature-disabled case, where /cdn-cgi/image/* 404s.
 *
 * `quality=85` is Cloudflare's own default. The edge never upscales
 * (`fit=scale-down` default), so an undersized `width` means the BROWSER
 * upscales — visibly blurry on DPR-1 monitors. Pick `width` ≥ the largest
 * CSS pixel width the slot can render at.
 *
 * Only same-zone /cdn/ images are wrapped — data:/blob:/foreign hosts pass
 * through untouched.
 */
export function cardImageUrl(
  ref: string | null | undefined,
  width = 480,
): string | undefined {
  const url = resolveImageUrl(ref);
  if (!url) return undefined;
  const base = cdnBase();
  let path: string | null = null;
  if (url.startsWith("/cdn/")) path = url;
  else if (base && url.startsWith(`${base}/cdn/`)) path = url.slice(base.length);
  if (!path) return url;
  return `${base}/cdn-cgi/image/width=${width},quality=85,format=auto,onerror=redirect${path}`;
}

/**
 * Undo a /cdn-cgi/image/ transform prefix — the client-side fallback target
 * when the transformation endpoint itself is unavailable (feature toggled
 * off → 404, which `onerror=redirect` cannot catch).
 */
export function originalImageUrl(url: string): string {
  const m = /^(.*?)\/cdn-cgi\/image\/[^/]+(\/cdn\/.*)$/.exec(url);
  return m ? `${m[1]}${m[2]}` : url;
}

/**
 * `<img onError>` handler for any src produced by `cardImageUrl`: swap back to
 * the untransformed original. The transform endpoint does not exist off
 * Cloudflare (local dev, or the feature toggled off), where it 404s — and
 * `onerror=redirect` cannot cover that case because it never runs.
 *
 * Self-terminating: after the swap `originalImageUrl` is a no-op on the new
 * src, so a genuinely broken image fails once instead of looping.
 */
export function fallbackToOriginalOnError(event: {
  currentTarget: HTMLImageElement;
}): void {
  const img = event.currentTarget;
  const original = originalImageUrl(img.src);
  if (original !== img.src) img.src = original;
}

/**
 * Resolve an asset reference to a usable URL.
 * - `http://...` or `https://...` → returned as-is
 * - `@asset:{uuid}` → resolved to permanent CDN URL `/cdn/{uuid}`
 * - Anything else → returned as-is
 */
export async function resolveAssetUrl(ref: string): Promise<string> {
  if (!ref) return ref;

  // Already a full URL
  if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;

  // Asset reference: @asset:{id} → permanent CDN URL (no API round-trip needed)
  if (ref.startsWith("@asset:")) {
    const assetId = ref.slice(7);
    return getAssetCdnUrl(assetId);
  }

  return ref;
}

/**
 * Resolve all `@asset:{id}` references in a string to presigned URLs.
 * Used for display transform replacements.
 */
export async function resolveAssetRefs(text: string): Promise<string> {
  const pattern = /@asset:([a-f0-9-]+)/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return text;

  let result = text;
  for (const match of matches) {
    const ref = match[0]; // @asset:{id}
    const resolved = await resolveAssetUrl(ref);
    result = result.replace(ref, resolved);
  }
  return result;
}
