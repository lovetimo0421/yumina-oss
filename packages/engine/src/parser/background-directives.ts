import type { BackgroundImage } from "../types/index.js";

/** `[bg: handle]` on its own, the way the AI is told to write it. Mirrors the
 *  scene-image directive so a model that learned one writes the other. */
const BG_DIRECTIVE_RE = /\[\s*bg\s*:\s*([^\]\n]{1,80})\]/gi;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Tell the AI which backgrounds exist and when each belongs.
 *
 *  Deliberately shorter than the scene-image block: a background is ambient,
 *  so the instruction that matters is "only when the place actually changes".
 *  A model that switches the backdrop every paragraph is worse than one that
 *  never switches it. */
export function buildBackgroundPromptBlock(backgrounds: BackgroundImage[]): string {
  const list = backgrounds
    .map((bg) => `  - ${bg.id}: ${oneLine(bg.scene ?? "") || oneLine(bg.name) || bg.id}`)
    .join("\n");
  return [
    "<backgrounds>",
    "The picture behind the whole conversation. Change it by writing [bg: id] on",
    "its own line when the story moves somewhere a different backdrop belongs.",
    "",
    list,
    "",
    "Only when the setting genuinely changes — not every reply, and never an id",
    "that is not listed. The backdrop stays put until you change it again, so",
    "there is no need to restate it. Never mention it in the narration.",
    "</backgrounds>",
  ].join("\n");
}

export interface ResolvedBackgroundDirectives {
  /** The reply with the directives stripped — a backdrop is not body text. */
  text: string;
  /** The last valid handle the reply asked for, or null. Last wins: a reply
   *  that walks through two rooms ends in the second one. */
  backgroundId: string | null;
}

/**
 * Pull `[bg: handle]` out of a reply.
 *
 * Unlike a scene image, this leaves nothing behind in the text: the directive
 * is an instruction to the renderer, not something the reader should see. An
 * unknown handle is dropped the same way, so a model that invents one costs
 * the reader a blank line rather than visible bracket noise.
 */
export function resolveBackgroundDirectives(
  text: string,
  backgrounds: BackgroundImage[],
): ResolvedBackgroundDirectives {
  if (!/\[\s*bg\s*:/i.test(text)) return { text, backgroundId: null };

  const byId = new Map<string, BackgroundImage>();
  const byName = new Map<string, BackgroundImage>();
  for (const bg of backgrounds) {
    byId.set(bg.id.toLowerCase(), bg);
    const name = oneLine(bg.name).toLowerCase();
    if (name && !byName.has(name)) byName.set(name, bg);
  }

  let last: string | null = null;
  const out = text.replace(BG_DIRECTIVE_RE, (_match, rawHandle: string) => {
    const handle = oneLine(rawHandle).toLowerCase();
    const bg = byId.get(handle) ?? byName.get(handle);
    if (bg) last = bg.id;
    return "";
  });

  // Stripping a whole-line directive leaves the blank line it sat on.
  const cleaned = out.replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, backgroundId: last };
}
