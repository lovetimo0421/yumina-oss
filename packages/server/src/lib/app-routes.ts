/**
 * Which addresses are pages of the app.
 *
 * The app is a single-page app, so the server answers any address it does not
 * otherwise know with the app shell. Without a list of the router's real
 * routes, "/pricing" or any made-up path came back 200 with an empty page,
 * which search engines file as a page (a soft 404). The list is generated
 * from the router's own tree (scripts/gen-app-routes.mjs) and
 * app-routes.test.ts fails when the two drift.
 */
import { APP_ROUTE_PATHS } from "./app-routes.gen.js";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One route pattern ("/app/users/$userId", "/krew/$") as a matcher. */
export function routePatternToRegex(pattern: string): RegExp {
  if (pattern === "/") return /^\/$/;
  const body = pattern
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      // A bare "$" is a splat: the rest of the address, slashes included.
      if (segment === "$") return "/.*";
      // "/$handle" is the public address route; the app itself rejects a
      // handle without "@" (routes/$handle.tsx), so "/pricing" is no page.
      if (segment === "$handle") return "/(?:@|%40)[^/]+";
      if (segment.startsWith("$")) return "/[^/]+";
      return `/${escapeRegex(segment)}`;
    })
    .join("");
  return new RegExp(`^${body}$`, "i");
}

const MATCHERS = APP_ROUTE_PATHS.map(routePatternToRegex);

/** True when the app's router has a route for this path. */
export function isAppRoute(rawPath: string, matchers: readonly RegExp[] = MATCHERS): boolean {
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") || "/" : rawPath || "/";
  return matchers.some((re) => re.test(path));
}
