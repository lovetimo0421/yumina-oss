import type { SceneImage, WorldDefinition } from "../types/index.js";

/**
 * Scene images — author-registered pictures the AI surfaces mid-narrative.
 *
 * The AI writes `[image: handle]` (a bare id, or the image's name). The server
 * expands that into the shared render syntax `[image:@asset:…|alt=…|scene=id]`
 * before the message is persisted, so every renderer (host markdown, sandbox
 * markdown, replays, exports) shows it with no knowledge of the world.
 */

/** `[image: handle]` — a single bare token, never a URL/asset ref (those are the
 *  already-expanded render form and must pass through untouched). */
const HANDLE_DIRECTIVE_RE = /\[\s*image:\s*([^\]\n|]*?)\s*\]/giu;
const SOURCE_LIKE_RE = /^(https?:\/\/|@asset:|\/cdn\/|data:)/i;

function oneLine(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Images the AI may pick from right now: AI-controllable, has a source and a
 *  "when to show it" sentence (the editor's one switch — the same bar the
 *  continuity judge's pool uses), and either unscoped or scoped to the
 *  session's current opening. */
export function getAiSceneImages(
  images: SceneImage[],
  activeGreetingId?: string | null,
): SceneImage[] {
  const current = activeGreetingId == null ? "" : String(activeGreetingId);
  return images.filter((img) => {
    if (img.allowAiControl === false) return false;
    if (!img.url || !img.url.trim()) return false;
    if (!img.scene || !img.scene.trim()) return false;
    const scope = img.greetingIds ?? [];
    if (scope.length === 0) return true;
    return current !== "" && scope.includes(current);
  });
}

/** The cacheable prompt block listing the images and the directive to show one. */
export function buildSceneImagePromptBlock(images: SceneImage[]): string {
  const list = images
    .map((img) => `  - ${img.id}: ${oneLine(img.scene) || oneLine(img.name) || img.id}`)
    .join("\n");
  return [
    "<scene-images>",
    "The author attached images to this story. Each line is an image id followed by",
    "the author's rule for when to send it. Follow each rule exactly as written: a",
    "rule like \"every reply\" or \"always\" means you send that image in every reply;",
    "a rule naming a moment or condition means you send it in every reply where that",
    "holds, even if it was sent before. Send an image by writing [image: id] on its",
    "own line at the point the reader should see it.",
    "",
    list,
    "",
    "Send every image whose rule this reply meets and none whose rule it does not.",
    "Never use an id that is not listed. Do not describe the image or mention that",
    "you are sending one; just let it appear.",
    "</scene-images>",
  ].join("\n");
}

/** The render token for one scene image, in the shared `[image:…]` embed syntax
 *  (also what the editor's "copy code" hands authors for first messages). */
export function sceneImageEmbed(img: SceneImage): string {
  const clean = (s: string) => s.replace(/[|\]\n]/g, " ").trim();
  const alt = clean(img.name) || img.id;
  return `[image:${img.url.trim()}|alt=${alt}|scene=${clean(img.id)}]`;
}

export interface ResolvedSceneImages {
  text: string;
  /** Registered images the reply revealed, in order of first appearance. */
  shown: SceneImage[];
}

/**
 * Expand `[image: handle]` directives in a parsed reply. Matches by id, then
 * id case-insensitively, then by name. Unknown handles are dropped rather than
 * left as visible bracket noise; a repeated handle shows once. Directives that
 * already carry a source (`[image:https://…]`, `[image:@asset:…]`) are the
 * render form and are left exactly as written.
 */
/**
 * Whether the world has its own variable called `image`. For such a world
 * `[image: …]` in a reply has always been a write to that variable (a card's
 * custom UI may read it), so the parser must not treat it as a picture.
 */
export function hasImageVariable(world: Pick<WorldDefinition, "variables">): boolean {
  return (world.variables ?? []).some(
    (v) => v.id.toLowerCase() === "image" || (v.name ?? "").trim().toLowerCase() === "image",
  );
}

/** An already-expanded scene image embed (`[image:@asset:…|alt=…|scene=id]`),
 *  with the blank lines in front of it. */
const EXPANDED_SCENE_RE = /(\n*)([ \t]*)\[\s*image:\s*[^\]\n|]+\|[^\]\n]*?\bscene=([^\]|\n]+?)\s*(?:\|[^\]\n]*)?\]/giu;

/** Whether the reply carries a scene image the model asked for itself — a bare
 *  `[image: handle]`, not an expanded embed copied out of history. */
export function hasSceneImageHandle(text: string): boolean {
  for (const m of text.matchAll(HANDLE_DIRECTIVE_RE)) {
    const handle = oneLine(m[1]);
    if (handle && !SOURCE_LIKE_RE.test(handle)) return true;
  }
  return false;
}

/**
 * The story model sees earlier replies with their images already expanded and
 * sometimes copies one verbatim into its new reply. Such a copy bypasses the
 * author's condition (and never reaches the gallery), so it is taken back:
 * `"strip"` removes it (the continuity judge decides images on its own), and
 * `"handle"` turns it back into `[image: id]` so it expands like any other
 * directive the narrator wrote. Only embeds of this world's scene images are
 * touched; anything else passes through.
 */
export function reclaimCopiedSceneImages(
  text: string,
  images: SceneImage[],
  mode: "strip" | "handle",
): string {
  if (images.length === 0 || !/scene=/i.test(text)) return text;
  const ids = new Set(images.map((img) => img.id));
  let touched = false;
  const out = text.replace(EXPANDED_SCENE_RE, (match, lead: string, indent: string, rawId: string) => {
    const id = oneLine(rawId);
    if (!ids.has(id)) return match;
    touched = true;
    return mode === "strip" ? "" : `${lead}${indent}[image: ${id}]`;
  });
  return touched && mode === "strip" ? out.replace(/^\n+/, "") : out;
}

export function resolveSceneImageDirectives(
  text: string,
  images: SceneImage[],
): ResolvedSceneImages {
  if (!/\[\s*image:/i.test(text)) return { text, shown: [] };

  const byId = new Map<string, SceneImage>();
  const byLowerId = new Map<string, SceneImage>();
  const byName = new Map<string, SceneImage>();
  for (const img of images) {
    byId.set(img.id, img);
    byLowerId.set(img.id.toLowerCase(), img);
    const name = oneLine(img.name).toLowerCase();
    if (name && !byName.has(name)) byName.set(name, img);
  }

  const shown: SceneImage[] = [];
  const seen = new Set<string>();
  const out = text.replace(HANDLE_DIRECTIVE_RE, (match, rawHandle: string) => {
    const handle = oneLine(rawHandle);
    if (!handle || SOURCE_LIKE_RE.test(handle)) return match;
    const img =
      byId.get(handle) ??
      byLowerId.get(handle.toLowerCase()) ??
      byName.get(handle.toLowerCase());
    if (!img || !img.url.trim()) return "";
    if (seen.has(img.id)) return "";
    seen.add(img.id);
    shown.push(img);
    return sceneImageEmbed(img);
  });

  return { text: out, shown };
}
