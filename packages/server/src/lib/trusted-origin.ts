import { env, PUBLIC_ORIGIN } from "./env.js";
import { TESTING_ORIGINS } from "./testing-origin.js";

/**
 * Same-site origin check for cookie-authenticated POSTs that sit outside
 * Better Auth (which does its own trustedOrigins check).
 *
 * Behind Railway's proxy `c.req.url` carries the internal host, so comparing
 * against it alone rejected every real browser (the browse-time beacon 403'd
 * on testing forever). The allowed set is the configured public origins —
 * the same list CORS and Better Auth trust — plus the origin the browser
 * addressed, as reported by the proxy's X-Forwarded-Host/Proto.
 */
export const CONFIGURED_TRUSTED_ORIGINS: readonly string[] = [
  PUBLIC_ORIGIN,
  env.APP_URL,
  env.BETTER_AUTH_URL,
  "https://yumina.io",
  "https://www.yumina.io",
  "https://creator.yumina.io",
  ...TESTING_ORIGINS,
].filter(Boolean);

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

function first(value: string | null | undefined): string {
  return (value ?? "").split(",")[0]!.trim();
}

/** Origins this request was addressed to: the raw URL and the proxy-forwarded host. */
export function addressedOrigins(requestUrl: string, headers: Headers): string[] {
  const out: string[] = [];
  const direct = normalize(requestUrl);
  if (direct) out.push(direct);
  const fallbackProto = direct?.startsWith("https:") ? "https" : "http";
  const forwardedProto = first(headers.get("x-forwarded-proto")).toLowerCase();
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : fallbackProto;
  for (const host of [first(headers.get("x-forwarded-host")), first(headers.get("host"))]) {
    if (host && HOST_RE.test(host)) out.push(`${proto}://${host.toLowerCase()}`);
  }
  return out;
}

/**
 * True when the request carries no Origin (same-origin navigation / non-browser)
 * or an Origin that is configured-trusted or equal to the origin the browser addressed.
 */
export function isTrustedRequestOrigin(
  origin: string | null | undefined,
  requestUrl: string,
  headers: Headers,
  configured: readonly string[] = CONFIGURED_TRUSTED_ORIGINS,
): boolean {
  if (!origin) return true;
  const wanted = normalize(origin);
  if (!wanted) return false;
  const allowed = new Set<string>();
  for (const value of configured) {
    const n = normalize(value);
    if (n) allowed.add(n);
  }
  for (const value of addressedOrigins(requestUrl, headers)) allowed.add(value);
  return allowed.has(wanted);
}
