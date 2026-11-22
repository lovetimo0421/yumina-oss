/**
 * Game pages the platform ships itself.
 *
 * A card's `schema.game.path` opens in a first-party frame: same origin, no
 * sandbox, the player's session with it. The card's author writes that field,
 * so it may only ever name one of these roots. "Same origin" is not enough of
 * a test: files users upload are served from the same origin too (/cdn), and
 * in November 2026 a card pointed its game frame at an uploaded page.
 *
 * Adding a first-party game means adding its root here. The app (which opens
 * the frame) and the server (which refuses to send such a card to review) both
 * read this one list.
 */
export const FIRST_PARTY_GAME_ROOTS = ["/pvz", "/krew", "/experiments"] as const;

export function isFirstPartyGamePath(path: unknown): path is string {
  // A plain absolute path on this origin: "//host" would be another site.
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return false;
  // Everything a browser would quietly rewrite is refused rather than
  // interpreted: backslashes become slashes ("/\evil.com" is "//evil.com"),
  // tabs and newlines are dropped ("/pvz/.\t./cdn" is "/pvz/../cdn"), and
  // encoded bytes decode into a different path after this check.
  if (path.includes("\\") || path.includes("%")) return false;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) <= 32) return false;
  }
  const pathname = path.split("?")[0]!.split("#")[0]!;
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return FIRST_PARTY_GAME_ROOTS.some((root) => pathname === root || pathname.startsWith(root + "/"));
}

/** The game path a card schema declares, when it is not one of ours; otherwise null. */
export function foreignGamePath(schema: unknown): string | null {
  const game = (schema as { game?: unknown } | null | undefined)?.game;
  if (!game || typeof game !== "object") return null;
  const path = (game as { path?: unknown }).path;
  if (path === undefined || path === null || path === "") return null;
  return isFirstPartyGamePath(path) ? null : String(path).slice(0, 200);
}
