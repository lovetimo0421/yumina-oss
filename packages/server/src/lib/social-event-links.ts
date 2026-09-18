import type { SocialPlatform } from "@yumina/shared";

export interface NormalizedSocialPostUrl {
  canonicalUrl: string;
  canonicalPostKey: string;
  riskFlags: string[];
}

const HOSTS_BY_PLATFORM: Record<SocialPlatform, readonly string[]> = {
  xiaohongshu: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"],
  douyin: ["douyin.com", "iesdouyin.com"],
  weibo: ["weibo.com", "weibo.cn", "t.cn"],
  bilibili: ["bilibili.com", "b23.tv"],
  kuaishou: ["kuaishou.com", "gifshow.com"],
  tiktok: ["tiktok.com"],
  instagram: ["instagram.com"],
  youtube: ["youtube.com", "youtu.be"],
  x: ["x.com", "twitter.com"],
  threads: ["threads.net", "threads.com"],
  reddit: ["reddit.com", "redd.it"],
};

const UNRESOLVED_SHORT_HOSTS = new Set([
  "xhslink.com",
  "xhslink.cn",
  "v.douyin.com",
  "b23.tv",
  "v.kuaishou.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "t.cn",
]);

// Same-host share paths that are redirects, not final post URLs. They get
// resolved server-side exactly like short-host links.
function isShortSharePath(platform: SocialPlatform, hostname: string, pathname: string): boolean {
  if (platform === "tiktok" && hostname.endsWith("tiktok.com")) return /^\/t\//i.test(pathname);
  if (platform === "reddit" && hostname.endsWith("reddit.com")) return /\/s\/[a-z0-9]+/i.test(pathname);
  return false;
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:www\.|m\.|mobile\.)/, "");
}

function hostMatches(hostname: string, accepted: readonly string[]): boolean {
  return accepted.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function normalizePath(pathname: string): string {
  const decoded = pathname
    .split("/")
    .map((part) => {
      try {
        return encodeURIComponent(decodeURIComponent(part));
      } catch {
        return part;
      }
    })
    .join("/");
  const collapsed = decoded.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return collapsed || "/";
}

function manualReviewFallback(
  platform: SocialPlatform,
  parsed: URL,
  reasonFlags: string[],
): NormalizedSocialPostUrl {
  const isShortLink = reasonFlags.includes("short_link");
  const fallbackUrl = new URL(parsed.toString());
  fallbackUrl.hash = "";
  // Short links keep their query so the redirect can be resolved. Accepted
  // unrecognized-format URLs drop query AND normalize the path so the dedup
  // key cannot be multiplied via tracking parameters or path noise.
  if (!isShortLink) {
    fallbackUrl.search = "";
    fallbackUrl.hostname = normalizeHost(fallbackUrl.hostname);
    fallbackUrl.pathname = normalizePath(fallbackUrl.pathname);
  }
  const canonicalUrl = fallbackUrl.toString();

  return {
    canonicalUrl,
    canonicalPostKey: `${platform}:url:${canonicalUrl}`,
    riskFlags: [...new Set(["manual_review_url", ...reasonFlags])],
  };
}

/**
 * Normalize recognized public social post URLs before uniqueness checks. URLs
 * that cannot be recognized are still accepted and flagged for manual review.
 */
export function normalizeSocialPostUrl(
  platform: SocialPlatform,
  rawUrl: string,
): NormalizedSocialPostUrl {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("INVALID_SOCIAL_URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("INVALID_SOCIAL_URL_PROTOCOL");
  }

  let hostname = normalizeHost(parsed.hostname);
  const isShortLink = UNRESOLVED_SHORT_HOSTS.has(hostname);
  if (!hostMatches(hostname, HOSTS_BY_PLATFORM[platform])) {
    return manualReviewFallback(
      platform,
      parsed,
      isShortLink ? ["platform_mismatch", "short_link"] : ["platform_mismatch"],
    );
  }
  if (isShortLink || isShortSharePath(platform, hostname, parsed.pathname)) {
    return manualReviewFallback(platform, parsed, ["short_link"]);
  }

  let pathname = normalizePath(parsed.pathname);
  let essentialQuery = "";
  const riskFlags: string[] = [];

  try {
    if (platform === "x" && hostname.endsWith("twitter.com")) {
      hostname = "x.com";
    }
    if (platform === "x") {
      const statusId = /\/status\/(\d+)/i.exec(pathname)?.[1];
      if (!statusId) throw new Error("INVALID_SOCIAL_POST_URL");
      pathname = `/i/status/${statusId}`;
    }
    if (platform === "youtube") {
      if (hostname === "youtu.be") {
        const videoId = pathname.split("/").filter(Boolean)[0];
        if (!videoId) throw new Error("INVALID_SOCIAL_POST_URL");
        hostname = "youtube.com";
        pathname = `/watch`;
        essentialQuery = `?v=${encodeURIComponent(videoId)}`;
      } else if (pathname === "/watch") {
        const videoId = parsed.searchParams.get("v")?.trim();
        if (!videoId) throw new Error("INVALID_SOCIAL_POST_URL");
        essentialQuery = `?v=${encodeURIComponent(videoId)}`;
      } else {
        const videoId = /^\/(?:shorts|embed|live)\/([^/]+)/i.exec(pathname)?.[1];
        if (!videoId) throw new Error("INVALID_SOCIAL_POST_URL");
        pathname = "/watch";
        essentialQuery = `?v=${encodeURIComponent(videoId)}`;
      }
    }
    if (platform === "xiaohongshu") {
      const postId = /^\/(?:explore|discovery\/item|user\/profile\/[^/]+)\/([a-z0-9]+)/i.exec(pathname)?.[1];
      if (!postId) throw new Error("INVALID_SOCIAL_POST_URL");
      hostname = "xiaohongshu.com";
      pathname = `/explore/${postId}`;
    }
    if (platform === "douyin") {
      const match = /\/(?:share\/)?(video|note)\/(\d+)/i.exec(pathname);
      if (!match) throw new Error("INVALID_SOCIAL_POST_URL");
      hostname = "douyin.com";
      pathname = `/${match[1]!.toLowerCase()}/${match[2]!}`;
    }
    if (platform === "weibo") {
      const postId = /^\/detail\/([a-z0-9]+)$/i.exec(pathname)?.[1]
        ?? /^\/status(?:es)?\/([a-z0-9]+)/i.exec(pathname)?.[1]
        ?? /^\/\d+\/([a-z0-9]+)(?:\/.*)?$/i.exec(pathname)?.[1];
      if (!postId) throw new Error("INVALID_SOCIAL_POST_URL");
      hostname = "weibo.com";
      pathname = `/detail/${postId}`;
    }
    if (platform === "kuaishou") {
      const postId = /^\/(?:short-video|f)\/([^/]+)/i.exec(pathname)?.[1]
        ?? /^\/profile\/[^/]+\/photo\/([^/]+)/i.exec(pathname)?.[1];
      if (!postId) throw new Error("INVALID_SOCIAL_POST_URL");
      hostname = "kuaishou.com";
      pathname = `/short-video/${postId}`;
    }
    if (platform === "instagram") {
      const match = /^\/(?:[^/]+\/)?(p|reel|reels|tv)\/([a-z0-9_-]+)/i.exec(pathname);
      if (!match) throw new Error("INVALID_SOCIAL_POST_URL");
      hostname = "instagram.com";
      pathname = `/${match[1]!.toLowerCase() === "reels" ? "reel" : match[1]!.toLowerCase()}/${match[2]!}`;
    }
    if (platform === "tiktok") {
      const match = /\/(video|photo)\/(\d+)/i.exec(pathname);
      if (!match) throw new Error("INVALID_SOCIAL_POST_URL");
      hostname = "tiktok.com";
      pathname = `/${match[1]!.toLowerCase()}/${match[2]!}`;
    }
    if (platform === "reddit") {
      const postId = /\/comments\/([a-z0-9]+)/i.exec(pathname)?.[1];
      if (hostname === "redd.it") {
        const shortId = pathname.split("/").filter(Boolean)[0];
        if (!shortId) throw new Error("INVALID_SOCIAL_POST_URL");
        hostname = "reddit.com";
        pathname = `/comments/${shortId.toLowerCase()}`;
      } else if (postId) {
        hostname = "reddit.com";
        pathname = `/comments/${postId.toLowerCase()}`;
      } else {
        throw new Error("INVALID_SOCIAL_POST_URL");
      }
    }
    if (platform === "threads") {
      // normalizePath percent-encodes "@" to "%40".
      const postId = /^\/(?:@|%40)[^/]+\/post\/([^/]+)/i.exec(pathname)?.[1];
      if (!postId) throw new Error("INVALID_SOCIAL_POST_URL");
      hostname = "threads.net";
      pathname = `/post/${postId}`;
    }
    if (platform === "bilibili") {
      const opusId = hostname === "t.bilibili.com"
        ? /^\/(\d+)$/.exec(pathname)?.[1]
        : /^\/opus\/(\d+)/i.exec(pathname)?.[1];
      const articleId = /^\/read\/cv(\d+)/i.exec(pathname)?.[1]
        ?? /^\/read\/mobile\/(\d+)/i.exec(pathname)?.[1];
      const videoId = /\/video\/((?:BV)[a-z0-9]+|av\d+)/i.exec(pathname)?.[1];
      if (opusId) {
        hostname = "bilibili.com";
        pathname = `/opus/${opusId}`;
      } else if (articleId) {
        hostname = "bilibili.com";
        pathname = `/read/cv${articleId}`;
      } else if (videoId) {
        hostname = "bilibili.com";
        pathname = `/video/${videoId.startsWith("av") ? videoId.toLowerCase() : `BV${videoId.slice(2)}`}`;
      } else {
        throw new Error("INVALID_SOCIAL_POST_URL");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_SOCIAL_POST_URL") {
      return manualReviewFallback(platform, parsed, ["unrecognized_post_format"]);
    }
    throw error;
  }

  const canonicalUrl = `https://${hostname}${pathname}${essentialQuery}`;
  return {
    canonicalUrl,
    canonicalPostKey: `${platform}:${hostname}${pathname}${essentialQuery}`,
    riskFlags,
  };
}

async function redirectLocation(
  url: URL,
  fetchImpl: typeof fetch,
  deadlineMs: number,
): Promise<string | null> {
  const request = async (method: "HEAD" | "GET") => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) throw new Error("SOCIAL_SHORT_LINK_RESOLUTION_TIMEOUT");
    const response = await fetchImpl(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(remainingMs, 1)),
      headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
    });
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    return location;
  };

  return await request("HEAD") ?? await request("GET");
}

/**
 * Resolve share redirects (short hosts and same-host share paths) before
 * claiming a post key, then accept the result. URLs are never rejected for
 * their domain — anything unrecognized is accepted and flagged
 * (`platform_mismatch` / `unrecognized_post_format`) for manual review with
 * a query-stripped dedup key.
 */
export async function resolveSocialPostUrl(
  platform: SocialPlatform,
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedSocialPostUrl> {
  const deadlineMs = Date.now() + 6_000;
  let currentUrl = rawUrl;

  for (let hop = 0; hop < 6; hop += 1) {
    const normalized = normalizeSocialPostUrl(platform, currentUrl);
    if (!normalized.riskFlags.includes("short_link")) {
      return normalized;
    }

    let location: string | null;
    try {
      location = await redirectLocation(new URL(normalized.canonicalUrl), fetchImpl, deadlineMs);
    } catch {
      throw new Error("SOCIAL_SHORT_LINK_RESOLUTION_FAILED");
    }
    if (!location) throw new Error("SOCIAL_SHORT_LINK_RESOLUTION_FAILED");

    let next: URL;
    try {
      next = new URL(location, new URL(normalized.canonicalUrl));
    } catch {
      throw new Error("SOCIAL_SHORT_LINK_RESOLUTION_FAILED");
    }
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      throw new Error("SOCIAL_SHORT_LINK_RESOLUTION_FAILED");
    }
    currentUrl = next.toString();
  }

  throw new Error("SOCIAL_SHORT_LINK_RESOLUTION_FAILED");
}

export function normalizeSocialAccountKey(value: string): string {
  const normalized = value.trim().replace(/^@+/, "").normalize("NFKC").toLocaleLowerCase("en-US");
  if (!normalized) throw new Error("SOCIAL_ACCOUNT_REQUIRED");
  if (normalized.length > 160) throw new Error("SOCIAL_ACCOUNT_TOO_LONG");
  return normalized;
}
