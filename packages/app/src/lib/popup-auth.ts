// OAuth in a popup window instead of navigating the current page away (used
// by the krew sign-in dialog; any embedded surface can reuse it). The popup
// ends on /auth/popup-done, which posts one message back to the opener and
// closes itself. Pure helpers here so the handshake is unit-tested without a
// browser, and edition-neutral so core routes may import them.

export const POPUP_AUTH_DONE = "yumina:popup-auth-done" as const;
export const POPUP_AUTH_WINDOW_NAME = "yumina-auth";

export type PopupAuthDoneMessage = { type: typeof POPUP_AUTH_DONE; error?: string };

/** The page the popup lands on after the provider round trip. */
export function popupAuthDoneUrl(origin: string, error = false): string {
  return `${origin}/auth/popup-done${error ? "?error=1" : ""}`;
}

export function parsePopupAuthDone(data: unknown): PopupAuthDoneMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== POPUP_AUTH_DONE) return null;
  const error = typeof record.error === "string" && record.error ? record.error.slice(0, 80) : undefined;
  return error ? { type: POPUP_AUTH_DONE, error } : { type: POPUP_AUTH_DONE };
}

/** Accept the message only from our own origin and from the window we opened. */
export function isPopupAuthDoneEvent(
  event: { origin: string; source: unknown; data: unknown },
  popup: Window | null,
  origin: string,
): PopupAuthDoneMessage | null {
  if (event.origin !== origin) return null;
  if (!popup || event.source !== popup) return null;
  return parsePopupAuthDone(event.data);
}

/** Centered popup sized for provider consent screens. */
export function authPopupFeatures(screen: {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
}): string {
  const width = 520;
  const height = 680;
  const left = Math.max(0, Math.round(screen.screenX + (screen.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(screen.screenY + (screen.outerHeight - height) / 2));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
}
