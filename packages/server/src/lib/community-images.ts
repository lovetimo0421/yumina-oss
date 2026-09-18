import { resolveImageCdn } from "./cdn-url.js";

export interface CommunityImageAttachment {
  url: string;
  name?: string;
}

const MAX_COMMUNITY_IMAGES = 12;
const INLINE_IMAGE_RE = /!\[[^\]]*]\([^)]+\)|\[image:[^\]\n]+]|<img\b/i;

function normalizeImageUrl(value: string): string | null {
  const url = value.trim().replace(/^<|>$/g, "");
  if (!url) return null;
  if (/^(javascript|vbscript|data):/i.test(url)) return null;
  if (url.startsWith("/") || url.startsWith("http://") || url.startsWith("https://")) return url;
  return resolveImageCdn(url);
}

export function normalizeCommunityImages(input: unknown): CommunityImageAttachment[] {
  if (!Array.isArray(input)) return [];

  const images: CommunityImageAttachment[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { url?: unknown; cdnUrl?: unknown; name?: unknown };
    const sourceUrl = typeof raw.url === "string"
      ? raw.url
      : typeof raw.cdnUrl === "string"
        ? raw.cdnUrl
        : "";
    const url = normalizeImageUrl(sourceUrl);
    if (!url || seen.has(url)) continue;

    seen.add(url);
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "";
    images.push(name ? { url, name } : { url });
    if (images.length >= MAX_COMMUNITY_IMAGES) break;
  }

  return images;
}

export function hasInlineCommunityImage(content: string | undefined): boolean {
  return INLINE_IMAGE_RE.test(content ?? "");
}
