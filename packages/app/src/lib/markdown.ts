import DOMPurify from "dompurify";
import { parseImageEmbeds, renderImageEmbedHtml } from "@yumina/engine";
import { resolveImageUrl } from "./asset-url";

interface HtmlEmbedPayload {
  html: string;
  css?: string;
  js?: string;
  height?: number;
}

interface HtmlEmbed {
  srcDoc: string;
  height: number;
}

const SUPPORTS_LOOKBEHIND = (() => {
  try { new RegExp("(?<!x)y"); return true; } catch { return false; }
})();
const ITALIC_RE = SUPPORTS_LOOKBEHIND
  ? /(?<!\*)\*([^*]+)\*(?!\*)/g
  : /\*([^*]+)\*/g;

const HTML_EMBED_LANGS = new Set(["html", "htm", "ui-html", "yumina-html"]);
const DEFAULT_HTML_EMBED_HEIGHT = 320;
const MIN_HTML_EMBED_HEIGHT = 120;
const MAX_HTML_EMBED_HEIGHT = 1200;

function renderMarkdownLinkHtml(linkText: string, href: string): string {
  const normalizedHref = href.trim();
  const safeText = linkText.trim();
  const isInternalLink = normalizedHref.startsWith("/");
  const isCommunityEventLink = normalizedHref.startsWith("/app/community/events/") || normalizedHref.startsWith("/app/invite-race");

  if (isCommunityEventLink) {
    return `<a href="${normalizedHref}" style="display:inline-flex;align-items:center;justify-content:center;padding:0.72rem 1.1rem;border-radius:999px;background:#C9A25E;color:#ffffff;font-weight:700;text-decoration:none;box-shadow:0 8px 20px rgba(156,116,37,0.18);">${safeText}</a>`;
  }

  return `<a href="${normalizedHref}"${isInternalLink ? "" : ' target="_blank"'}>${safeText}</a>`;
}

const MARKDOWN_ASSET_SRC_RE =
  /^(?:@asset:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creators paste library assets into descriptions as `![](@asset:{uuid})`.
 * Left alone that becomes a relative URL the browser can never load, so map
 * the two unambiguous asset shapes onto the CDN and leave every other src
 * (http, /cdn, data:, relative paths) untouched.
 */
function resolveMarkdownImageSrc(src: string): string {
  const trimmed = src.trim();
  if (!MARKDOWN_ASSET_SRC_RE.test(trimmed)) return trimmed;
  return resolveImageUrl(trimmed) ?? trimmed;
}

function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HTML_EMBED_HEIGHT;
  return Math.min(MAX_HTML_EMBED_HEIGHT, Math.max(MIN_HTML_EMBED_HEIGHT, Math.round(value)));
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

function buildHtmlEmbedSrcDoc(payload: HtmlEmbedPayload): string {
  const htmlBody = payload.html.trim();
  if (/<html[\s>]/i.test(htmlBody) || /<!doctype/i.test(htmlBody)) {
    return htmlBody;
  }

  const css = (payload.css ?? "").trim();
  const js = (payload.js ?? "").trim();
  const inlineCss = css.length > 0 ? `<style>${css}</style>` : "";
  const inlineJs = js.length > 0 ? `<script>${escapeInlineScript(js)}</script>` : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        min-height: 100%;
        background: transparent;
        max-width: 100%;
        overflow-x: hidden;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      *, *::before, *::after {
        box-sizing: border-box;
        max-width: 100%;
      }
      img, video, canvas, svg, iframe {
        max-width: 100%;
        height: auto;
      }
      table {
        width: 100%;
      }
    </style>
    ${inlineCss}
  </head>
  <body>
    ${htmlBody}
    ${inlineJs}
  </body>
</html>`;
}

function parseHtmlEmbed(code: string): HtmlEmbed {
  const trimmed = code.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<HtmlEmbedPayload>;
      if (typeof parsed.html === "string" && parsed.html.trim().length > 0) {
        const payload: HtmlEmbedPayload = {
          html: parsed.html,
          css: typeof parsed.css === "string" ? parsed.css : undefined,
          js: typeof parsed.js === "string" ? parsed.js : undefined,
          height: typeof parsed.height === "number" ? parsed.height : undefined,
        };
        return {
          srcDoc: buildHtmlEmbedSrcDoc(payload),
          height: clampHeight(payload.height ?? DEFAULT_HTML_EMBED_HEIGHT),
        };
      }
    } catch {
      // Fall through and treat block as raw HTML.
    }
  }

  return {
    srcDoc: buildHtmlEmbedSrcDoc({ html: code }),
    height: DEFAULT_HTML_EMBED_HEIGHT,
  };
}

function renderHtmlEmbedHtml(embed: HtmlEmbed): string {
  const srcDoc = escapeHtmlAttribute(embed.srcDoc);
  return `<iframe class="my-2 w-full rounded-lg border border-border/50 bg-transparent" style="height:${embed.height}px;" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" srcdoc="${srcDoc}"></iframe>`;
}

/**
 * Render a chat message to safe HTML.
 *
 * Pipeline:
 *   1. Protect code blocks / inline code from processing
 *   2. Parse image embed directives [image:https://...|size=...|placement=...]
 *   3. Escape HTML in non-code regions
 *   4. Apply built-in markdown (bold, italic)
 *   5. Restore code blocks
 *   6. Add line breaks
 *   7. Restore image embeds
 *   8. Restore html iframe embeds from ```html``` blocks
 *   9. Sanitize with DOMPurify
 */
export function renderMessage(raw: string): string {
  const codeBlocks: string[] = [];
  const htmlEmbeds: HtmlEmbed[] = [];
  let html = raw;

  // Fenced code blocks ```...```
  html = html.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const normalizedLang = String(lang ?? "").trim().toLowerCase();
    if (HTML_EMBED_LANGS.has(normalizedLang)) {
      const idx = htmlEmbeds.length;
      htmlEmbeds.push(parseHtmlEmbed(code));
      return `\x00HB${idx}\x00`;
    }

    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre class="my-2 rounded bg-black/30 p-3 text-sm overflow-x-auto"><code>${escapeHtml(code)}</code></pre>`,
    );
    return `\x00CB${idx}\x00`;
  });

  // Inline code `...`
  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<code class="rounded bg-black/30 px-1.5 py-0.5 text-sm">${escapeHtml(code)}</code>`,
    );
    return `\x00CB${idx}\x00`;
  });

  // Parse [image:...] directives outside code blocks.
  const parsedImages = parseImageEmbeds(html);
  const imageEmbeds = parsedImages.embeds;
  html = parsedImages.cleanText;

  html = escapeHtml(html);

  // Bold + italic: ***...***
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  // Bold: **...**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic: *...*
  html = html.replace(ITALIC_RE, "<em>$1</em>");

  // Standard markdown images: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
    return `<img src="${resolveMarkdownImageSrc(src)}" alt="${alt}" class="rounded-lg max-w-full" loading="lazy" />`;
  });

  // Standard markdown links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, href) => {
    return renderMarkdownLinkHtml(text, href);
  });

  html = html.replace(/\x00CB(\d+)\x00/g, (_match, idx) => codeBlocks[Number(idx)] ?? "");

  html = html.replace(/\n/g, "<br />");

  // Restore rich image cards.
  html = html.replace(/\x00IM(\d+)\x00/g, (_match, idx) => {
    const embed = imageEmbeds[Number(idx)];
    return embed ? renderImageEmbedHtml(embed, resolveMarkdownImageSrc) : "";
  });

  // Restore iframe-based html ui blocks.
  html = html.replace(/\x00HB(\d+)\x00/g, (_match, idx) => {
    const embed = htmlEmbeds[Number(idx)];
    return embed ? renderHtmlEmbedHtml(embed) : "";
  });

  html = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "span",
      "div",
      "img",
      "strong",
      "em",
      "br",
      "hr",
      "button",
      "p",
      "pre",
      "code",
      "b",
      "i",
      "a",
      "iframe",
    ],
    ALLOWED_ATTR: [
      "class",
      "style",
      "src",
      "srcdoc",
      "alt",
      "referrerpolicy",
      "data-yumina-choice",
      "href",
      "target",
      "sandbox",
      "loading",
    ],
  });

  return html;
}

/**
 * Render markdown to safe HTML.
 * This is the utility exposed to message renderer components via extraProps.
 */
export function renderMarkdown(text: string): string {
  return renderMessage(text);
}

function isSafeProfileBioHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("//")) return false;
  return /^(https?:\/\/|mailto:|\/(?!\/))/i.test(trimmed);
}

function renderProfileBioInlineMarkdown(raw: string): string {
  const tokens: string[] = [];
  let text = raw;

  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = tokens.length;
    tokens.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00PB${idx}\x00`;
  });

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const trimmedHref = String(href ?? "").trim();
    if (!isSafeProfileBioHref(trimmedHref)) return escapeHtml(String(label ?? ""));

    const idx = tokens.length;
    const external = !trimmedHref.startsWith("/");
    tokens.push(
      `<a href="${escapeHtmlAttribute(trimmedHref)}"${external ? ' target="_blank" rel="noopener noreferrer nofollow ugc"' : ""}>${escapeHtml(String(label ?? ""))}</a>`,
    );
    return `\x00PB${idx}\x00`;
  });

  let html = escapeHtml(text);
  html = html
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(ITALIC_RE, "<em>$1</em>");

  html = html.replace(/\x00PB(\d+)\x00/g, (_match, idx) => tokens[Number(idx)] ?? "");
  return html;
}

/**
 * Lightweight markdown for user profile bios.
 *
 * Intentionally narrower than community/chat markdown: supports paragraphs,
 * line breaks, simple lists, links, bold/italic, and inline code only. Images,
 * raw HTML, iframes, and embedded UI blocks are not allowed on profiles.
 */
export function renderProfileBioMarkdown(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    output.push(`<p>${paragraph.map(renderProfileBioInlineMarkdown).join("<br />")}</p>`);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderProfileBioInlineMarkdown(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i++;
      }
      i--;
      output.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${renderProfileBioInlineMarkdown(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      i--;
      output.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();

  return DOMPurify.sanitize(output.join(""), {
    ALLOWED_TAGS: ["strong", "em", "br", "p", "code", "a", "ul", "ol", "li"],
    ALLOWED_ATTR: ["href", "target", "rel"],
  });
}

type MarkdownTheme = "light" | "dark";

interface MarkdownThemeStyles {
  h1: string;
  h2: string;
  h3: string;
  blockquote: string;
  table: string;
  th: string;
  td: string;
}

const TABLE_LAYOUT_STYLE = "width:100%;border-collapse:collapse;margin:0.75rem 0;font-size:0.95em;";
const TABLE_CELL_STYLE = "padding:0.5rem 0.65rem;vertical-align:top;text-align:left;";

const MARKDOWN_THEME_STYLES: Record<MarkdownTheme, MarkdownThemeStyles> = {
  light: {
    h1: "font-size:1.5rem;font-weight:700;color:#000;margin-top:1.5rem;margin-bottom:0.5rem;",
    h2: "font-size:1.125rem;font-weight:700;color:#000;",
    h3: "font-size:1rem;font-weight:600;color:#2a6a74;",
    blockquote: "border-left:3px solid #C9A25E;background:rgba(201,162,94,0.08);padding:0.75rem 1rem;border-radius:0.5rem;margin:0.75rem 0;color:#333;",
    table: TABLE_LAYOUT_STYLE,
    th: `${TABLE_CELL_STYLE}border:1px solid rgba(0,0,0,0.12);background:rgba(0,0,0,0.04);font-weight:700;`,
    td: `${TABLE_CELL_STYLE}border:1px solid rgba(0,0,0,0.12);`,
  },
  dark: {
    h1: "font-size:1.5rem;font-weight:700;color:rgba(255,255,255,0.95);margin-top:1.5rem;margin-bottom:0.5rem;",
    h2: "font-size:1.125rem;font-weight:700;color:rgba(255,255,255,0.9);",
    h3: "font-size:1rem;font-weight:600;color:#C9A25E;",
    blockquote: "border-left:3px solid #C9A25E;background:rgba(201,162,94,0.06);padding:0.75rem 1rem;border-radius:0.5rem;margin:0.75rem 0;color:rgba(255,255,255,0.75);",
    table: TABLE_LAYOUT_STYLE,
    th: `${TABLE_CELL_STYLE}border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);font-weight:700;`,
    td: `${TABLE_CELL_STYLE}border:1px solid rgba(255,255,255,0.12);`,
  },
};

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER_RE = /^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;

/**
 * Split one `| a | b |` row into trimmed cells, honouring `\|` escapes.
 * Written as a manual scan rather than a lookbehind split so Safari < 16.4
 * (which throws on lookbehind — see SUPPORTS_LOOKBEHIND above) still parses it.
 */
function splitTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let idx = 0; idx < body.length; idx++) {
    const char = body[idx];
    if (char === "\\" && body[idx + 1] === "|") {
      current += "|";
      idx++;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function tableCellAlignments(dividerLine: string): (string | null)[] {
  return splitTableRow(dividerLine).map((spec) => {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

function applyInlineEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(ITALIC_RE, "<em>$1</em>");
}

function applyInlineImagesAndLinks(escaped: string): string {
  return escaped
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
      return `<img src="${resolveMarkdownImageSrc(src)}" alt="${alt}" class="rounded-lg max-w-full" loading="lazy" />`;
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, href) => {
      return renderMarkdownLinkHtml(linkText, href);
    });
}

function buildTableHtml(
  headerCells: string[],
  alignments: (string | null)[],
  bodyRows: string[][],
  themeStyles: MarkdownThemeStyles,
): string {
  const columnCount = Math.max(headerCells.length, ...bodyRows.map((row) => row.length), 1);
  const renderRow = (cells: string[], tag: "th" | "td") => {
    const base = tag === "th" ? themeStyles.th : themeStyles.td;
    const parts: string[] = [];
    for (let column = 0; column < columnCount; column++) {
      const align = alignments[column];
      const style = align ? `${base}text-align:${align};` : base;
      const cell = applyInlineImagesAndLinks(applyInlineEmphasis(escapeHtml(cells[column] ?? "")));
      parts.push(`<${tag} style="${style}">${cell}</${tag}>`);
    }
    return `<tr>${parts.join("")}</tr>`;
  };

  // A header row of blank cells (`| | |`) is how creators build image grids;
  // rendering an empty <thead> would just add a stray band, so drop it.
  const head = headerCells.some((cell) => cell.length > 0)
    ? `<thead>${renderRow(headerCells, "th")}</thead>`
    : "";
  const body = bodyRows.length > 0
    ? `<tbody>${bodyRows.map((row) => renderRow(row, "td")).join("")}</tbody>`
    : "";

  return `<div style="overflow-x:auto;max-width:100%;"><table style="${themeStyles.table}">${head}${body}</table></div>`;
}

/**
 * Richer markdown renderer for community posts / threads.
 * Supports headings, horizontal rules, unordered & ordered lists,
 * plus everything renderMessage already handles (bold, italic, code, images, links).
 *
 * `theme` only affects inline color/background styles on headings and
 * blockquotes — useful when rendering onto a dark surface where the default
 * light-theme colors would be invisible.
 */
export function renderCommunityMarkdown(
  raw: string,
  options?: { theme?: MarkdownTheme },
): string {
  const themeStyles = MARKDOWN_THEME_STYLES[options?.theme ?? "light"];
  const codeBlocks: string[] = [];
  const htmlEmbeds: HtmlEmbed[] = [];
  // Tables are restored AFTER the newline → <br /> pass; splicing them in
  // earlier would sprinkle stray <br /> between <tr>/<td>, which the HTML
  // parser hoists out of the table and turns into blank rows.
  const tableBlocks: string[] = [];
  let text = raw;

  // Protect fenced code blocks
  text = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const normalizedLang = String(lang ?? "").trim().toLowerCase();
    if (HTML_EMBED_LANGS.has(normalizedLang)) {
      const idx = htmlEmbeds.length;
      htmlEmbeds.push(parseHtmlEmbed(code));
      return `\x00HB${idx}\x00`;
    }
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre class="my-2 rounded bg-black/[0.06] p-3 text-sm overflow-x-auto"><code>${escapeHtml(code)}</code></pre>`,
    );
    return `\x00CB${idx}\x00`;
  });

  // Protect inline code
  text = text.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<code class="rounded bg-black/[0.06] px-1.5 py-0.5 text-sm">${escapeHtml(code)}</code>`,
    );
    return `\x00CB${idx}\x00`;
  });

  // Parse [image:...] directives
  const parsedImages = parseImageEmbeds(text);
  const imageEmbeds = parsedImages.embeds;
  text = parsedImages.cleanText;

  // Process line by line
  const lines = text.split("\n");
  const outputLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Table: a `| a | b |` header, a `|---|---|` divider, then body rows.
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_DIVIDER_RE.test(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      const alignments = tableCellAlignments(lines[i + 1]);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const idx = tableBlocks.length;
      tableBlocks.push(buildTableHtml(headerCells, alignments, bodyRows, themeStyles));
      outputLines.push(`\x00TB${idx}\x00`);
      continue;
    }

    // Horizontal rule: --- or *** or ___ (standalone)
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      outputLines.push("<hr />");
      i++;
      continue;
    }

    // Headings: # ## ###
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = escapeHtml(headingMatch[2]);
      const formatted = content
        .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(ITALIC_RE, "<em>$1</em>");
      const headingStyles: Record<number, string> = {
        1: themeStyles.h1,
        2: themeStyles.h2,
        3: themeStyles.h3,
      };
      outputLines.push(`<h${level} style="${headingStyles[level] ?? ""}">${formatted}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote: > line
    if (/^>\s?/.test(line)) {
      const bqLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        const content = lines[i].replace(/^>\s?/, "");
        let escaped = escapeHtml(content);
        escaped = escaped
          .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(ITALIC_RE, "<em>$1</em>");
        bqLines.push(escaped);
        i++;
      }
      outputLines.push(
        `<blockquote style="${themeStyles.blockquote}">${bqLines.join("<br />")}</blockquote>`,
      );
      continue;
    }

    // Unordered list: - item
    if (/^\s*-\s+/.test(line)) {
      outputLines.push("<ul>");
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        const itemText = escapeHtml(lines[i].replace(/^\s*-\s+/, ""));
        const formatted = itemText
          .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(ITALIC_RE, "<em>$1</em>");
        outputLines.push(`<li>${formatted}</li>`);
        i++;
      }
      outputLines.push("</ul>");
      continue;
    }

    // Ordered list: 1. item
    if (/^\s*\d+\.\s+/.test(line)) {
      outputLines.push("<ol>");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const itemText = escapeHtml(lines[i].replace(/^\s*\d+\.\s+/, ""));
        const formatted = itemText
          .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(ITALIC_RE, "<em>$1</em>");
        outputLines.push(`<li>${formatted}</li>`);
        i++;
      }
      outputLines.push("</ol>");
      continue;
    }

    // Regular line — escape and apply inline formatting
    let escaped = escapeHtml(line);
    escaped = escaped
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(ITALIC_RE, "<em>$1</em>");

    // Standard markdown images `![alt](url)` and links `[text](url)`
    escaped = applyInlineImagesAndLinks(escaped);

    outputLines.push(escaped);
    i++;
  }

  let html = outputLines.join("\n");

  // Restore code blocks
  html = html.replace(/\x00CB(\d+)\x00/g, (_match, idx) => codeBlocks[Number(idx)] ?? "");

  // Convert remaining newlines to <br /> (but not inside block elements)
  // Replace double newlines with paragraph breaks, single with <br />
  html = html
    .replace(/\n{2,}/g, "<br /><br />")
    .replace(/\n/g, "<br />");

  // Restore image embeds
  html = html.replace(/\x00IM(\d+)\x00/g, (_match, idx) => {
    const embed = imageEmbeds[Number(idx)];
    return embed ? renderImageEmbedHtml(embed, resolveMarkdownImageSrc) : "";
  });

  // Restore html embeds
  html = html.replace(/\x00HB(\d+)\x00/g, (_match, idx) => {
    const embed = htmlEmbeds[Number(idx)];
    return embed ? renderHtmlEmbedHtml(embed) : "";
  });

  // Restore tables (after the <br /> pass, see tableBlocks above)
  html = html.replace(/\x00TB(\d+)\x00/g, (_match, idx) => tableBlocks[Number(idx)] ?? "");

  html = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "span", "div", "img", "strong", "em", "br", "hr", "button", "p",
      "pre", "code", "b", "i", "a", "iframe",
      "h1", "h2", "h3", "ul", "ol", "li", "blockquote",
      "table", "thead", "tbody", "tr", "th", "td",
    ],
    ALLOWED_ATTR: [
      "class", "style", "src", "srcdoc", "alt", "referrerpolicy",
      "data-yumina-choice", "href", "target", "sandbox", "loading",
    ],
  });

  return html;
}

export function stripMarkdownForPreview(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
    .replace(/^\s*\|[\s:|-]*\|\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
