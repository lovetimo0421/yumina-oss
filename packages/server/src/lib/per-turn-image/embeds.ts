// A reply's picture rides at the end of its text as
// `[image:/cdn/key/<base64url of users/…/turn-images/….jpg>|alt=…]`, earlier
// draws listed in the same embed (`|versions=…`, @yumina/shared
// turn-image-versions.ts), so the pictures follow the reply variant they were
// drawn for. Kept apart from illustrate.ts so it carries no DB or GPU imports.
import { addTurnImageVersion, selectTurnImageVersion } from "@yumina/shared";

const EMBED_RE = /\n*\[\s*image:\s*\/cdn\/key\/([A-Za-z0-9_-]+)[^\]\n]*\]/g;

function isTurnImageKey(b64: string): boolean {
  try {
    return Buffer.from(b64, "base64url").toString("utf8").includes("/turn-images/");
  } catch {
    return false;
  }
}

/** Removes per-turn illustration embeds. The model sees earlier replies (with
 *  their embeds) in history and sometimes copies one into its new reply. */
export function stripTurnImages(text: string): string {
  return text.replace(EMBED_RE, (match, b64: string) => (isTurnImageKey(b64) ? "" : match));
}

/** The reply's last per-turn picture embed and where it sits. */
function lastTurnImage(text: string): { start: number; end: number; embed: string } | null {
  let found: { start: number; end: number; embed: string } | null = null;
  for (const match of text.matchAll(EMBED_RE)) {
    if (isTurnImageKey(match[1]!)) found = { start: match.index!, end: match.index! + match[0].length, embed: match[0].trim() };
  }
  return found;
}

/** The reply with a freshly drawn picture shown, the pictures drawn for it
 *  before kept as earlier versions (oldest dropped past the cap). */
export function withDrawnTurnImage(current: string, drawn: string): string {
  const previous = lastTurnImage(current)?.embed;
  return `${stripTurnImages(current).trimEnd()}\n\n${addTurnImageVersion(previous, drawn)}`;
}

/** The reply showing another of its picture's versions (by storage key), the
 *  text around it untouched. Null when the reply has no such version. */
export function withTurnImageVersion(current: string, key: string): string | null {
  const found = lastTurnImage(current);
  if (!found) return null;
  const next = selectTurnImageVersion(found.embed, key);
  if (!next) return null;
  const whole = current.slice(found.start, found.end);
  return current.slice(0, found.start) + whole.replace(found.embed, next) + current.slice(found.end);
}
