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

function parseOneDirective(inner: string): ImageEmbed | null {
  const tokens = inner.split("|").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return null;

  const url = tokens[0] ?? "";
  if (!/^https:\/\//i.test(url)) return null;

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

export function renderImageEmbedHtml(embed: ImageEmbed): string {
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

  const alt = escapeHtml(embed.alt || "Embedded image");
  const caption = embed.caption ? `<div class="mt-1 text-xs text-muted-foreground/70">${escapeHtml(embed.caption)}</div>` : "";

  return (
    `<div class="my-3 flex ${justify}">` +
    `<div class="rounded-lg border border-border/60 bg-background/60 p-2" style="${width}">` +
    `<img src="${escapeHtml(embed.url)}" alt="${alt}" referrerpolicy="no-referrer" class="h-auto w-full rounded-md object-cover" />` +
    caption +
    `</div>` +
    `</div>`
  );
}
