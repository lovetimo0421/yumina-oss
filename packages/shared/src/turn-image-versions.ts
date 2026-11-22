// Every picture drawn for one reply, so a redraw that came out worse can be
// stepped back from. A reply's picture rides at the end of its text as
// `[image:/cdn/key/<shown>|alt=…]` (server: lib/per-turn-image/illustrate.ts),
// which keeps it with the reply variant (swipe) it was drawn for. Earlier
// draws ride in the same embed:
//
//   [image:/cdn/key/<shown>|alt=…|versions=<oldest>,…,<newest>]
//
// The address in front is the version the player picked: everything that
// shows or reuses the picture reads that address and ignores the list, and a
// reply with one picture has no list at all (the format before versions).
// Keys are the base64url storage keys from the `/cdn/key/` path.

/** Most pictures kept per reply; a redraw past this drops the oldest. */
export const TURN_IMAGE_VERSION_CAP = 10;

const EMBED_RE = /^\[\s*image:\s*\/cdn\/key\/([A-Za-z0-9_-]+)([^\]\n]*)\]$/;
const KEY_RE = /^[A-Za-z0-9_-]+$/;
const VERSIONS_RE = /^versions\s*=/i;

export interface TurnImageVersions {
  /** Storage keys, oldest first. Always holds the shown one. */
  keys: string[];
  /** Which of `keys` is shown. */
  index: number;
  /** The embed's other `|name=value` options (alt…), kept as written. */
  options: string[];
}

/** The versions in one per-turn picture embed; null if it isn't one. */
export function readTurnImageVersions(embed: string): TurnImageVersions | null {
  const match = EMBED_RE.exec(embed.trim());
  if (!match) return null;
  const shown = match[1]!;
  const options: string[] = [];
  let listed: string[] = [];
  for (const token of match[2]!.split("|").map((t) => t.trim()).filter(Boolean)) {
    if (VERSIONS_RE.test(token)) {
      listed = token.slice(token.indexOf("=") + 1).split(",").map((k) => k.trim()).filter((k) => KEY_RE.test(k));
    } else options.push(token);
  }
  const keys = [...new Set(listed)];
  if (!keys.includes(shown)) keys.push(shown);
  return { keys, index: keys.indexOf(shown), options };
}

/** The embed for these versions, showing `keys[index]`. */
export function writeTurnImageEmbed(versions: TurnImageVersions): string {
  const index = Math.min(Math.max(0, versions.index), versions.keys.length - 1);
  const tokens = [...versions.options];
  if (versions.keys.length > 1) tokens.push(`versions=${versions.keys.join(",")}`);
  return `[image:/cdn/key/${versions.keys[index]}${tokens.map((t) => `|${t}`).join("")}]`;
}

/**
 * A redraw landed: `drawn` (a fresh one-picture embed) becomes the shown
 * version, after every version `previous` already had. Past `cap` the oldest
 * go. Without a previous picture this is just `drawn`.
 */
export function addTurnImageVersion(previous: string | null | undefined, drawn: string, cap = TURN_IMAGE_VERSION_CAP): string {
  const added = readTurnImageVersions(drawn);
  if (!added) return drawn;
  const key = added.keys[added.index]!;
  const before = previous ? readTurnImageVersions(previous)?.keys ?? [] : [];
  const keys = [...before.filter((k) => k !== key), key].slice(-Math.max(1, cap));
  return writeTurnImageEmbed({ keys, index: keys.length - 1, options: added.options });
}

/**
 * The embed showing another version: by position, or by storage key (what
 * the server is sent, so a list that changed meanwhile can't pick the wrong
 * one). Null when that version isn't in the embed.
 */
export function selectTurnImageVersion(embed: string, target: number | string): string | null {
  const versions = readTurnImageVersions(embed);
  if (!versions) return null;
  const index = typeof target === "number" ? target : versions.keys.indexOf(target);
  if (!Number.isInteger(index) || index < 0 || index >= versions.keys.length) return null;
  return writeTurnImageEmbed({ ...versions, index });
}
