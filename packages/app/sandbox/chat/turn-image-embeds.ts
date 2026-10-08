// Per-turn pictures ride at the very end of a reply as
// `[image:/cdn/key/<base64url of users/…/turn-images/….jpg>|alt=…]`
// (server: lib/per-turn-image/illustrate.ts). A card with its own bubble
// renderer often slices the reply itself — 问道 treats everything after
// 【去向】 as choice buttons and drops long lines — so the picture vanished
// with no error. We peel these embeds off before the card sees the text and
// draw them under the card's bubble instead.

const EMBED_RE = /\n*\[\s*image:\s*\/cdn\/key\/([A-Za-z0-9_-]+)[^\]\n]*\]/g;

function keyIn(b64: string, dir: string): boolean {
  try {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)).includes(dir);
  } catch {
    return false;
  }
}
const isTurnImageKey = (b64: string) => keyIn(b64, "/turn-images/");

export interface SplitTurnImages {
  /** The reply with per-turn picture embeds removed. */
  text: string;
  /** The removed embeds, in order, ready for renderMessage. */
  embeds: string[];
}

export function splitTurnImages(text: string): SplitTurnImages {
  if (!text.includes("/cdn/key/")) return { text, embeds: [] };
  const embeds: string[] = [];
  const stripped = text.replace(EMBED_RE, (match, b64: string) => {
    if (!isTurnImageKey(b64)) return match;
    embeds.push(match.trim());
    return "";
  });
  return embeds.length ? { text: stripped.trimEnd(), embeds } : { text, embeds };
}

// A reply's short film rides the same way, a `[video:/cdn/key/<…/turn-videos/….mp4>|sound]` per
// shot (server: lib/realtime-video/turn-clip.ts). The chat peels them off and shows nothing: the
// film window plays them (src/features/chat/realtime-video/controller.ts).
const VIDEO_EMBED_RE = /\n*\[\s*video:\s*\/cdn\/key\/([A-Za-z0-9_-]+)[^\]\n]*\]/g;

export function splitTurnVideos(text: string): SplitTurnImages {
  if (!text.includes("/cdn/key/")) return { text, embeds: [] };
  const embeds: string[] = [];
  const stripped = text.replace(VIDEO_EMBED_RE, (match, b64: string) => {
    if (!keyIn(b64, "/turn-videos/")) return match;
    embeds.push(match.trim());
    return "";
  });
  return embeds.length ? { text: stripped.trimEnd(), embeds } : { text, embeds };
}
