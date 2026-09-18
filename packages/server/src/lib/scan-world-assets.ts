/**
 * Comprehensive asset audit for moderation review.
 *
 * Walks a world's full schema (recursively) and extracts EVERY image-like
 * reference: cover art, gallery, in-content @asset refs, base64 data URIs,
 * external https:// URLs, <img> tags inside customUI TSX, CSS url() etc.
 *
 * Critical for moderation: a creator could otherwise sneak inappropriate
 * images into a lorebook entry, a customUI background, or a base64 blob and
 * we'd never notice from the cover thumbnail alone.
 *
 * Returns flat, deduped list — UI groups by source type and shows admin a
 * grid of thumbnails to eyeball.
 */

import { resolveImageCdn } from "./cdn-url.js";

export type AssetSourceType =
  | "thumbnail"      // worlds.thumbnailUrl
  | "gallery"        // worlds.galleryImages[N]
  | "asset_ref"      // @asset:{UUID} reference in any string
  | "data_uri"       // data:image/...;base64,... — RED FLAG
  | "external_url"   // raw https:// URL with image extension
  | "html_img"       // <img src="..."> inside TSX / markdown
  | "css_url";       // background-image: url(...) inside TSX / styles

export interface DetectedAsset {
  source: AssetSourceType;
  /** Raw token from source (truncated for data: URIs) */
  raw: string;
  /** Dot-path location, e.g. "schema.customUI[2].tsxCode" */
  location: string;
  /** Resolvable URL the admin browser can render. null when origin is unknown. */
  resolvedUrl: string | null;
  /** For data: URIs, approximate base64 byte length. */
  byteLength?: number;
}

// Regex contract notes:
// - All patterns are case-insensitive on extension.
// - DATA_URI_RE matches anything that looks like a small or large embedded
//   image. The 50-char base64 floor catches even tiny embeds (favicons,
//   1x1 spacers) while still ignoring strings that just happen to contain
//   "data:image/".
const DATA_URI_RE = /data:image\/[a-z0-9+.-]+;base64,([A-Za-z0-9+/=]{50,})/gi;
const ASSET_REF_RE = /@asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const EXTERNAL_IMG_URL_RE =
  /https?:\/\/[^\s'"`)<>]+\.(?:jpg|jpeg|png|gif|webp|svg|avif|bmp|ico)(?:\?[^\s'"`)<>]*)?/gi;
const HTML_IMG_SRC_RE = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
const CSS_URL_RE = /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi;

const SKIP_LARGE_TEXT_THRESHOLD = 1_500_000; // 1.5 MB

interface ScanInput {
  thumbnailUrl?: string | null;
  galleryImages?: string[] | null;
  schema?: Record<string, unknown> | null;
}

export function scanWorldForAssets(world: ScanInput): DetectedAsset[] {
  const out: DetectedAsset[] = [];
  // Dedup key = location + first 80 chars of raw. Stops the same data URI
  // from filling the UI with 50 copies.
  const seen = new Set<string>();
  function push(asset: DetectedAsset) {
    const normalized = asset.raw.startsWith("data:image")
      ? {
          ...asset,
          source: "data_uri" as const,
          raw: asset.raw.slice(0, 60) + (asset.raw.length > 60 ? "..." : ""),
          resolvedUrl: null,
          byteLength: asset.byteLength ?? asset.raw.length,
        }
      : asset;
    const key = normalized.location + "::" + normalized.raw.slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  }

  if (world.thumbnailUrl) {
    push({
      source: "thumbnail",
      raw: world.thumbnailUrl,
      location: "thumbnailUrl",
      resolvedUrl: resolveImageCdn(world.thumbnailUrl),
    });
  }

  if (Array.isArray(world.galleryImages)) {
    world.galleryImages.forEach((g, i) => {
      if (typeof g !== "string" || g.length === 0) return;
      push({
        source: "gallery",
        raw: g,
        location: `galleryImages[${i}]`,
        resolvedUrl: resolveImageCdn(g),
      });
    });
  }

  if (world.schema) walk(world.schema, "schema", push);

  return out;
}

function walk(
  node: unknown,
  path: string,
  push: (a: DetectedAsset) => void,
): void {
  if (node == null) return;
  if (typeof node === "string") {
    scanString(node, path, push);
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walk(node[i], `${path}[${i}]`, push);
    }
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, push);
    }
  }
}

function scanString(
  text: string,
  location: string,
  push: (a: DetectedAsset) => void,
): void {
  if (text.length === 0) return;

  // Cheap pre-filter: if the string is huge and contains none of our marker
  // substrings, skip the regex passes. Entry content can legitimately be
  // megabytes of prose with no images.
  if (text.length > SKIP_LARGE_TEXT_THRESHOLD) {
    if (
      !text.includes("@asset:") &&
      !text.includes("data:image") &&
      !text.includes("<img") &&
      !text.includes("url(") &&
      !text.includes("http")
    ) {
      return;
    }
  }

  for (const m of text.matchAll(ASSET_REF_RE)) {
    push({
      source: "asset_ref",
      raw: m[0],
      location,
      resolvedUrl: resolveImageCdn(m[0]),
    });
  }

  for (const m of text.matchAll(DATA_URI_RE)) {
    const raw = m[0];
    push({
      source: "data_uri",
      raw: raw.slice(0, 60) + (raw.length > 60 ? "…" : ""),
      location,
      resolvedUrl: null,
      byteLength: raw.length,
    });
  }

  for (const m of text.matchAll(HTML_IMG_SRC_RE)) {
    const src = m[1];
    if (!src) continue;
    if (src.startsWith("@asset:") || src.startsWith("data:")) continue;
    push({
      source: "html_img",
      raw: src,
      location,
      resolvedUrl: resolveImageCdn(src),
    });
  }

  for (const m of text.matchAll(CSS_URL_RE)) {
    const url = m[1];
    if (!url) continue;
    if (url.startsWith("@asset:") || url.startsWith("data:")) continue;
    // CSS url() can reference fonts, audio etc. — only keep if it looks
    // like an image or is a generic http(s) URL that we'll show as-is.
    if (
      !/\.(?:jpg|jpeg|png|gif|webp|svg|avif|bmp|ico)(?:\?|$)/i.test(url) &&
      !url.startsWith("http")
    ) {
      continue;
    }
    push({
      source: "css_url",
      raw: url,
      location,
      resolvedUrl: resolveImageCdn(url),
    });
  }

  for (const m of text.matchAll(EXTERNAL_IMG_URL_RE)) {
    push({
      source: "external_url",
      raw: m[0],
      location,
      resolvedUrl: m[0],
    });
  }
}
