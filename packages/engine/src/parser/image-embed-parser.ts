export type ImageEmbedSize = "sm" | "md" | "lg" | "full";
export type ImageEmbedPlacement = "left" | "center" | "right";

export interface ImageEmbed {
  /** `[video:…]` embeds share the image options and sizing. Absent = image. */
  kind?: "image" | "video";
  /** Video only: play on a loop (default) or once (`once`). */
  loop?: boolean;
  /** Video only: with sound (`sound`: controls, waits for a tap) or muted autoplay (default). */
  sound?: boolean;
  url: string;
  alt?: string;
  caption?: string;
  /** Scene image id this embed was expanded from (`scene=` option), so the
   *  player UI can tell which registered image just got revealed. */
  scene?: string;
  size: ImageEmbedSize;
  placement: ImageEmbedPlacement;
}

export interface ParsedImageEmbeds {
  cleanText: string;
  embeds: ImageEmbed[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Sources an embed may point at: an https URL, a library asset ref
 * (`@asset:{uuid}`, resolved by the renderer / sandbox), or a same-origin CDN
 * path. Anything else — http, data:, javascript:, bare words — is refused so
 * model output can never smuggle an arbitrary src into the page.
 */
export function isImageEmbedSource(url: string): boolean {
  return (
    /^https:\/\/\S+$/i.test(url) ||
    /^@asset:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url) ||
    /^\/cdn\/\S+$/i.test(url)
  );
}

function parseOneDirective(inner: string, kind: "image" | "video"): ImageEmbed | null {
  const tokens = inner.split("|").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return null;

  const url = tokens[0] ?? "";
  if (!isImageEmbedSource(url)) return null;

  const embed: ImageEmbed = {
    url,
    size: "md",
    placement: "center",
    ...(kind === "video" ? { kind, loop: true, sound: false } : {}),
  };

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    const eq = token.indexOf("=");
    if (eq === -1) {
      // Bare video flags: loop | once | sound | muted.
      if (kind === "video") {
        const flag = token.toLowerCase();
        if (flag === "loop") embed.loop = true;
        else if (flag === "once") embed.loop = false;
        else if (flag === "sound") embed.sound = true;
        else if (flag === "muted") embed.sound = false;
      }
      continue;
    }
    const key = token.slice(0, eq).trim().toLowerCase();
    const value = token.slice(eq + 1).trim();
    if (!value) continue;

    if (key === "alt") embed.alt = value;
    else if (key === "caption") embed.caption = value;
    else if (key === "scene") embed.scene = value;
    else if (key === "size" && (value === "sm" || value === "md" || value === "lg" || value === "full")) {
      embed.size = value;
    } else if (key === "placement" && (value === "left" || value === "center" || value === "right")) {
      embed.placement = value;
    }
  }

  return embed;
}

/**
 * Parse inline image and video directives from model output.
 * Syntax:
 *   [image:https://example.com/a.png]
 *   [image:@asset:0f1e…|alt=Scene|scene=img1]
 *   [image:https://...|alt=Scene|caption=A dark forest|size=lg|placement=center]
 *   [video:@asset:0f1e…|once|sound|size=lg]   (default: looping, muted, autoplay)
 */
export function parseImageEmbeds(text: string): ParsedImageEmbeds {
  const embeds: ImageEmbed[] = [];
  const cleanText = text.replace(/\[(image|video):([^\]\n]+)\]/gi, (match, kind: string, body: string) => {
    const parsed = parseOneDirective(body, kind.toLowerCase() === "video" ? "video" : "image");
    if (!parsed) return match;
    const idx = embeds.length;
    embeds.push(parsed);
    return `\x00IM${idx}\x00`;
  });
  return { cleanText, embeds };
}

/**
 * @param resolveUrl Optional mapper from the stored source (e.g. `@asset:…`)
 *   to a loadable URL. Renderers that leave `@asset:` refs for a DOM pass
 *   can omit it.
 * @param resolveVideoUrl The same for videos, which must not go through an
 *   image resizer. Without it a library ref is served as-is from `/cdn/`.
 */
export function renderImageEmbedHtml(
  embed: ImageEmbed,
  resolveUrl?: (url: string) => string,
  resolveVideoUrl?: (url: string) => string,
): string {
  const justify =
    embed.placement === "left"
      ? "justify-start"
      : embed.placement === "right"
      ? "justify-end"
      : "justify-center";

  const width =
    embed.size === "sm"
      ? "max-width: 16rem;"
      : embed.size === "md"
      ? "max-width: 24rem;"
      : embed.size === "lg"
      ? "max-width: 32rem;"
      : "max-width: 100%;";

  const caption = embed.caption ? `<div class="mt-1 text-xs text-muted-foreground/70">${escapeHtml(embed.caption)}</div>` : "";
  const sceneAttr = embed.scene ? ` data-scene-image="${escapeHtml(embed.scene)}"` : "";

  let media: string;
  if (embed.kind === "video") {
    const asset = /^@asset:([0-9a-f-]{36})$/i.exec(embed.url);
    const src = resolveVideoUrl ? resolveVideoUrl(embed.url) : asset ? `/cdn/${asset[1]}` : embed.url;
    // Browsers only autoplay muted video; a clip with sound waits for the player's tap.
    const playback = embed.sound
      ? `controls preload="metadata"${embed.loop ? " loop" : ""}`
      : `autoplay muted playsinline preload="auto"${embed.loop !== false ? " loop" : ""}`;
    media = `<video src="${escapeHtml(src)}" ${playback} class="h-auto w-full rounded-md"></video>`;
  } else {
    const src = resolveUrl ? resolveUrl(embed.url) : embed.url;
    const alt = escapeHtml(embed.alt || "Embedded image");
    media = `<img src="${escapeHtml(src)}" alt="${alt}" referrerpolicy="no-referrer" class="h-auto w-full rounded-md object-cover" />`;
  }

  return (
    `<div class="my-3 flex ${justify}"${sceneAttr}>` +
    `<div class="rounded-lg border border-border/60 bg-background/60 p-2" style="${width}">` +
    media +
    caption +
    `</div>` +
    `</div>`
  );
}
