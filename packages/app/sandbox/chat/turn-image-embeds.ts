// Per-turn pictures ride at the very end of a reply as
// `[image:/cdn/key/<base64url of users/…/turn-images/….jpg>|alt=…]`
// (server: lib/per-turn-image/illustrate.ts). A card with its own bubble
// renderer often slices the reply itself — 问道 treats everything after
// 【去向】 as choice buttons and drops long lines — so the picture vanished
// with no error. We peel these embeds off before the card sees the text and
// draw them under the card's bubble instead.

const EMBED_RE = /\n*\[\s*image:\s*\/cdn\/key\/([A-Za-z0-9_-]+)[^\]\n]*\]/g;

function isTurnImageKey(b64: string): boolean {
  try {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)).includes("/turn-images/");
  } catch {
    return false;
  }
}

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
