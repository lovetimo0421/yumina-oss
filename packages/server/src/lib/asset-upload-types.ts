import { isActiveContentType } from "./asset-mime.js";

/**
 * What may be uploaded as what. Every upload path asks here: card assets,
 * library assets, bundle copies. These rules used to be written out once per
 * route, and a fix made in one copy (August: refuse HTML) never reached the
 * others, which is how an HTML page was uploaded as a card asset in November.
 * A new upload path imports this; it does not grow its own list.
 */
export const ASSET_TYPES = ["image", "video", "audio", "font", "txt", "other"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export function isAssetType(value: string | undefined | null): value is AssetType {
  return !!value && (ASSET_TYPES as readonly string[]).includes(value);
}

export const ALLOWED_MIME_TYPES: Record<AssetType, readonly string[]> = {
  video: ["video/mp4", "video/webm"],
  image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  audio: [
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/aac",
    "audio/mp4",
    "audio/x-wav",
  ],
  font: [
    "font/woff",
    "font/woff2",
    "font/ttf",
    "font/otf",
    "application/font-woff",
    "application/font-woff2",
    "application/x-font-woff",
    "application/x-font-woff2",
    "application/x-font-ttf",
    "application/x-font-truetype",
    "application/x-font-otf",
    "application/vnd.ms-opentype",
    "application/font-sfnt",
    "font/sfnt",
  ],
  txt: [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
  ],
  // `other` is the escape hatch for formats we don't enumerate (3D models,
  // sprite atlases, binary data tables). It stays open by design — but NOT to
  // active content: /cdn serves these bytes from the app's own origin, so an
  // uploaded text/html or application/javascript would be stored XSS on
  // yumina.io, and SVG carries script too. Those are denied below instead of
  // being allowlisted here, so a legitimate unknown format still uploads.
  other: [],
};

/**
 * Why this content type cannot be stored under this asset type, or null when it
 * can. Active content (a page, a script) is refused for every type, `other`
 * included: /cdn serves these bytes from the app's own origin.
 */
export function uploadTypeRefusal(assetType: AssetType, contentType: string): string | null {
  if (isActiveContentType(contentType)) return "This file type cannot be uploaded";
  const allowed = ALLOWED_MIME_TYPES[assetType];
  if (allowed.length > 0 && !allowed.includes(contentType)) return `Invalid content type for ${assetType}`;
  return null;
}
