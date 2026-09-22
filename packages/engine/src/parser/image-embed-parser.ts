export type ImageEmbedSize = "sm" | "md" | "lg" | "full";
export type ImageEmbedPlacement = "left" | "center" | "right";

export interface ImageEmbed {
  url: string;
  alt?: string;
  caption?: string;
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

function parseOneDirective(inner: string): ImageEmbed | null {
  const tokens = inner.split("|").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return null;

  const url = tokens[0] ?? "";
  if (!isImageEmbedSource(url)) return null;

  const embed: ImageEmbed = {
    url,
    size: "md",
    placement: "center",
  };

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    const key = token.slice(0, eq).trim().toLowerCase();
    const value = token.slice(eq + 1).trim();
    if (!value) continue;

    if (key === "alt") embed.alt = value;
    else if (key === "caption") embed.caption = value;
    else if (key === "size" && (value === "sm" || value === "md" || value === "lg" || value === "full")) {
      embed.size = value;
    } else if (key === "placement" && (value === "left" || value === "center" || value === "right")) {
      embed.placement = value;
    }
  }

  return embed;
}

/**
 * Parse inline image directives from model output.
 * Syntax:
 *   [image:https://example.com/a.png]
 *   [image:@asset:0f1e…|alt=Scene]
 *   [image:https://...|alt=Scene|caption=A dark forest|size=lg|placement=center]
 */
export function parseImageEmbeds(text: string): ParsedImageEmbeds {
  const embeds: ImageEmbed[] = [];
  const cleanText = text.replace(/\[image:([^\]\n]+)\]/gi, (match, body: string) => {
    const parsed = parseOneDirective(body);
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
 */
export function renderImageEmbedHtml(
  embed: ImageEmbed,
  resolveUrl?: (url: string) => string,
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

  const src = resolveUrl ? resolveUrl(embed.url) : embed.url;
  const alt = escapeHtml(embed.alt || "Embedded image");
  const caption = embed.caption ? `<div class="mt-1 text-xs text-muted-foreground/70">${escapeHtml(embed.caption)}</div>` : "";

  return (
    `<div class="my-3 flex ${justify}">` +
    `<div class="rounded-lg border border-border/60 bg-background/60 p-2" style="${width}">` +
    `<img src="${escapeHtml(src)}" alt="${alt}" referrerpolicy="no-referrer" class="h-auto w-full rounded-md object-cover" />` +
    caption +
    `</div>` +
    `</div>`
  );
}
