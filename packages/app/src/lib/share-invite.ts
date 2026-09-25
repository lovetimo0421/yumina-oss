/**
 * World links carry the sharer's invite code as `?ref=CODE`, so a friend who
 * signs up from a shared world counts as invited — the same as `/invite/CODE`.
 *
 * The code goes into the same pending slot the invite landing page uses, and
 * `usePendingReferral` redeems it after sign-in with every server check intact
 * (48-hour window, no self-invites, one referrer per account). An explicit
 * `/invite/` link already waiting wins over a world link.
 */
export const PENDING_REFERRAL_KEY = "yumina:pendingReferralCode";

const CODE = /^[A-Z0-9]{5,8}$/;

/** Read `?ref=` from the first URL, before routing can rewrite it. */
export function rememberShareInvite(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = new URL(window.location.href).searchParams.get("ref");
    const code = raw?.trim().toUpperCase();
    if (!code || !CODE.test(code)) return;
    if (localStorage.getItem(PENDING_REFERRAL_KEY)) return;
    localStorage.setItem(PENDING_REFERRAL_KEY, code);
  } catch { /* Storage may be disabled; the link still opens the world. */ }
}

/** Add the sharer's code to a link, when they have one. */
export function withShareInvite(url: string, code: string | null | undefined): string {
  if (!code || !CODE.test(code)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("ref", code);
    return u.toString();
  } catch {
    return url;
  }
}
