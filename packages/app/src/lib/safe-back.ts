const INTERNAL_URL_BASE = "https://yumina.invalid";
import { getLandingRoute } from "@/edition/routes";

export interface InternalBackHistory {
  location: { state: { __TSR_index?: number } };
  back: () => void;
  replace: (path: string) => void;
  canGoBack: () => boolean;
}

/**
 * Fallbacks are code-owned routes, but validate them anyway so this helper can
 * never become an open redirect if a caller later passes user-controlled data.
 */
export function parseSafeInternalFallback(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return undefined;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return undefined;
  }

  try {
    const parsed = new URL(value, INTERNAL_URL_BASE);
    if (parsed.origin !== INTERNAL_URL_BASE || parsed.username || parsed.password) {
      return undefined;
    }
    if (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/")) {
      return undefined;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

/**
 * TanStack assigns index zero to the first Yumina entry and increments it only
 * for router-owned pushes. An index above zero therefore proves Back will stay
 * inside this app; browser history length alone cannot make that guarantee.
 */
export function hasInternalBackEntry(history: InternalBackHistory): boolean {
  const index = history.location.state.__TSR_index;
  return typeof index === "number" && Number.isInteger(index) && index > 0 && history.canGoBack();
}

/** Return to the exact router entry, or replace a direct link with its parent. */
export function navigateBackSafely(
  history: InternalBackHistory,
  fallback: string = getLandingRoute(),
): void {
  if (hasInternalBackEntry(history)) {
    history.back();
    return;
  }

  history.replace(parseSafeInternalFallback(fallback) ?? getLandingRoute());
}
