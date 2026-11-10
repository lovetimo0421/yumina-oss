// A reply's short film rides at the end of its text as one embed per shot,
// `[video:/cdn/key/<base64url of users/…/turn-videos/….mp4>|sound]` (server:
// lib/realtime-video/turn-clip.ts). Only the film window plays it (turn-video.ts); the chat and
// cards never show the markup. Pure, so the sandbox bridge and tests can use it.

const TURN_VIDEO_EMBED = /\n*\[\s*video:\s*\/cdn\/key\/([A-Za-z0-9_-]+)[^\]\n]*\]/g;

function isTurnVideoKey(b64: string): boolean {
  try {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)).includes("/turn-videos/");
  } catch {
    return false;
  }
}

/** The `/cdn/key/…` paths of a reply's film shots, in playing order (none: not filmed). */
export function turnVideoPaths(content: string): string[] {
  if (!content.includes("/cdn/key/")) return [];
  return [...content.matchAll(TURN_VIDEO_EMBED)].filter((m) => isTurnVideoKey(m[1])).map((m) => `/cdn/key/${m[1]}`);
}

/** Where a film's notes are (the passage each shot films): beside its first shot,
 *  `<filmId>-<i>.mp4` → `<filmId>.json` (server: turnFilmNotesKey). */
export function turnFilmNotesPath(shotPath: string): string | null {
  const m = /^\/cdn\/key\/([A-Za-z0-9_-]+)$/.exec(shotPath);
  if (!m) return null;
  try {
    const padded = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const key = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)).replace(/-\d+\.mp4$/, ".json");
    return `/cdn/key/${btoa(key).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  } catch {
    return null;
  }
}

/** The reply without its film (other videos stay). */
export function stripTurnVideos(content: string): string {
  if (!content.includes("/cdn/key/")) return content;
  let found = false;
  const out = content.replace(TURN_VIDEO_EMBED, (match, b64: string) => {
    if (!isTurnVideoKey(b64)) return match;
    found = true;
    return "";
  });
  return found ? out.trimEnd() : content;
}
