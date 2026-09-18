const INTERNAL_URL_BASE = "https://yumina.invalid";

/** Session changes inherit the original entry; other pages become a new entry. */
export function getPlayNavigationSearch(
  pathname: string,
  currentSearch: Record<string, unknown>,
  explicit: { returnTo?: string; returnKey?: string } | undefined,
  capture: () => { returnTo?: string; returnKey?: string },
): { moderationGroupKey?: string; returnTo?: string; returnKey?: string } {
  const isPlay = pathname.startsWith("/app/chat/") || pathname.startsWith("/app/preview/");
  const context = isPlay ? currentSearch : (explicit ?? capture());
  return {
    moderationGroupKey: isPlay && typeof currentSearch.moderationGroupKey === "string"
      ? currentSearch.moderationGroupKey : undefined,
    returnTo: parseSafeInternalReturnUrl(context.returnTo),
    returnKey: parseStoryReturnKey(context.returnKey),
  };
}

/**
 * Accept only same-origin path URLs. This deliberately rejects absolute URLs,
 * protocol-relative URLs, backslash host tricks, and non-path schemes before a
 * return target is ever handed to the router.
 */
export function parseSafeInternalReturnUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return undefined;
  }
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;

  try {
    const parsed = new URL(value, INTERNAL_URL_BASE);
    if (parsed.origin !== INTERNAL_URL_BASE) return undefined;
    if (parsed.username || parsed.password) return undefined;
    const isAppRoute = parsed.pathname === "/app" || parsed.pathname.startsWith("/app/");
    if (!isAppRoute && parsed.pathname !== "/notifications") return undefined;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

export function parseStoryReturnKey(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9-]{10,100}$/.test(value)
    ? value
    : undefined;
}
