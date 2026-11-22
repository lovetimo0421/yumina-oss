import { resolveImageCdn } from "./cdn-url.js";
import { PUBLIC_ORIGIN } from "./env.js";

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

/**
 * An announcement's pictures in its text (an update post shows each screenshot beside what it describes, and its
 * English translation shows the English ones): allowed only as markdown images whose every address is a picture on
 * this site's CDN (/cdn/..., relative or on this origin). No <img>, no [image:...], nothing from elsewhere.
 */
export function inlineImagesAreOurs(content: string, origin = PUBLIC_ORIGIN): boolean {
  if (/<img\b|\[image:/i.test(content)) return false;
  const urls = [...content.matchAll(/!\[[^\]]*]\(([^)]*)\)/g)].map((m) => m[1]!.trim());
  return urls.length > 0 && urls.every((u) => /^\/cdn\/[A-Za-z0-9/_=.-]+$/.test(u) || (u.startsWith(`${origin}/cdn/`) && /^[A-Za-z0-9/_=.:-]+$/.test(u)));
}
