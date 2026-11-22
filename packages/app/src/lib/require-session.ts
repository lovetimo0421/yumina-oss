import { redirect } from "@tanstack/react-router";
import { getSessionSafe, isSessionUnverified } from "@/lib/auth-client";
import { parseSafeAuthReturnTo } from "@/lib/auth-return";
import { loginRedirectFor } from "@/lib/session-check";

/**
 * `beforeLoad` guard for pages that need an account. Signed out → /login, and
 * back to this page afterwards when it is an allowed return target. A session
 * that could not be verified lets the page load (see loginRedirectFor).
 */
export async function requireSession(location: { href: string }) {
  const session = await getSessionSafe();
  const target = loginRedirectFor(session, isSessionUnverified(session), parseSafeAuthReturnTo(location.href));
  if (target) throw redirect(target);
  return session;
}
