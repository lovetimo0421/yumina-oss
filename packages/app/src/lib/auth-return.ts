import { isPvzModelPickerReturnTo } from "./pvz-model-handoff";
import { parseSafeInternalReturnUrl } from "./story-return-url";

export type SafeAuthReturnTo = string;

/** True when the value is a first-party game path (the PvZ invite flow sends refused joiners
 *  through auth and straight back into their friend's room). Path-only -- never a protocol or
 *  host -- so auth can only ever return somewhere on this origin. */
/** krew.io inside Yumina: `/krew` or `/krew?path=<encoded krew deep link>`. The
 *  krew frame's own Sign-in button sends players through auth and straight back
 *  into the game (features/krew). Path-only like the rest of this file. */
export function isKrewReturnTo(value: string): boolean {
  if (value === "/krew") return true;
  return value.startsWith("/krew?") && value.length <= 700 && !/[\n\r\\]/.test(value);
}

export function isGameReturnTo(value: string): boolean {
  // The experiment entry is a static game document, outside the SPA router.
  if (value === "/experiments/unperson/" || value === "/experiments/unperson/?voice=1"
    || value === "/experiments/unperson/?voice=1&new=1") return true;
  if (isPvzModelPickerReturnTo(value)) return true;
  if (isKrewReturnTo(value)) return true;
  return value.startsWith("/pvz/") && !value.startsWith("//") && value.length <= 200
    && !/[\n\r\\]/.test(value);
}

/**
 * A card a guest was looking at when they hit "sign up to play": the preview,
 * the card page or a chat. Signing up used to drop them on Discover, and they
 * had to find the card again (launch QA). SPA paths only — the same-origin
 * checks of parseSafeInternalReturnUrl, then an allowlist so auth can never be
 * used to bounce someone into arbitrary app pages (admin, settings…).
 */
export function isCardReturnTo(value: string): boolean {
  const safe = parseSafeInternalReturnUrl(value);
  return safe === value && /^\/app\/(preview|hub|chat)(\/[^/?#]+)?\/?([?#]|$)/.test(value);
}

export function parseSafeAuthReturnTo(value: unknown): SafeAuthReturnTo | undefined {
  if (value === "/delete-account") return value;
  if (typeof value === "string" && isGameReturnTo(value)) return value;
  if (typeof value === "string" && isCardReturnTo(value)) return value;
  return undefined;
}

/** Set when auth hands the player back to what they were doing: that page
 *  must not open with a promo popup over it (invite-race-promo.tsx). */
export const AUTH_RETURN_FLAG = "yumina:auth-returned";

export function markAuthReturn(): void {
  try { sessionStorage.setItem(AUTH_RETURN_FLAG, String(Date.now())); } catch { /* private mode */ }
}

/** True (once) when this page load is an auth return from the last 2 minutes. */
export function consumeAuthReturn(): boolean {
  try {
    const at = Number(sessionStorage.getItem(AUTH_RETURN_FLAG));
    sessionStorage.removeItem(AUTH_RETURN_FLAG);
    return Number.isFinite(at) && at > 0 && Date.now() - at < 120_000;
  } catch {
    return false;
  }
}

export function readSafeAuthReturnTo(search: string): SafeAuthReturnTo | undefined {
  return parseSafeAuthReturnTo(new URLSearchParams(search).get("returnTo"));
}
