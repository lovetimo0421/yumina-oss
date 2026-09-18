/**
 * Sandbox-side markdown renderer.
 *
 * Ported from packages/app/src/lib/markdown.ts with minimal changes:
 * - Import paths adjusted for sandbox bundle
 * - No other behavioral changes
 */

import DOMPurify from "dompurify";
import { parseImageEmbeds, renderImageEmbedHtml } from "@yumina/engine";

// ── HTML embed types ───────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────

function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HTML_EMBED_HEIGHT;
  return Math.min(
    MAX_HTML_EMBED_HEIGHT,
    Math.max(MIN_HTML_EMBED_HEIGHT, Math.round(value)),
  );
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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── HTML embed builder ─────────────────────────────────────────────

function buildHtmlEmbedSrcDoc(payload: HtmlEmbedPayload): string {
  const htmlBody = payload.html.trim();
  if (/<html[\s>]/i.test(htmlBody) || /<!doctype/i.test(htmlBody)) {
    return htmlBody;
  }

  const css = (payload.css ?? "").trim();
  const js = (payload.js ?? "").trim();
  const inlineCss = css.length > 0 ? `<style>${css}</style>` : "";
  const inlineJs =
    js.length > 0 ? `<script>${escapeInlineScript(js)}</script>` : "";

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
          height:
            typeof parsed.height === "number" ? parsed.height : undefined,
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
  return `<iframe class="my-2 w-full rounded-lg border border-border/50 bg-transparent" style="height:${embed.height}px;" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" loading="lazy" srcdoc="${srcDoc}"></iframe>`;
}

// ── Render cache ──────────────────────────────────────────────────

const _renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 2000;

// ── Main render pipeline ───────────────────────────────────────────

/**
 * Render a chat message to safe HTML (cached).
 *
 * Completed messages have stable content, so caching avoids re-running
 * the full markdown + DOMPurify pipeline on every React re-render.
 * Only the actively-streaming message misses cache (content changes per token).
 */
export function renderMessage(raw: string): string {
  const cached = _renderCache.get(raw);
  if (cached !== undefined) return cached;

  const html = renderMessageUncached(raw);

  // LRU eviction — Map iteration order = insertion order
  if (_renderCache.size >= RENDER_CACHE_MAX) {
    const firstKey = _renderCache.keys().next().value;
    if (firstKey !== undefined) _renderCache.delete(firstKey);
  }
  _renderCache.set(raw, html);
  return html;
}

/**
 * Render pipeline (uncached).
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
function renderMessageUncached(raw: string): string {
  const codeBlocks: string[] = [];
  const htmlEmbeds: HtmlEmbed[] = [];
  let html = raw;

  // Fenced code blocks ```...```
  html = html.replace(
    /```([\w-]*)\n?([\s\S]*?)```/g,
    (_match, lang, code) => {
      const normalizedLang = String(lang ?? "")
        .trim()
        .toLowerCase();
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
    },
  );

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
  html = html.replace(
    /\*\*\*(.+?)\*\*\*/g,
    "<strong><em>$1</em></strong>",
  );
  // Bold: **...**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic: *...*
  html = html.replace(ITALIC_RE, "<em>$1</em>");

  html = html.replace(
    /\x00CB(\d+)\x00/g,
    (_match, idx) => codeBlocks[Number(idx)] ?? "",
  );

  html = html.replace(/\n/g, "<br />");

  // Restore rich image cards.
  html = html.replace(/\x00IM(\d+)\x00/g, (_match, idx) => {
    const embed = imageEmbeds[Number(idx)];
    return embed ? renderImageEmbedHtml(embed) : "";
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
 * This is the utility exposed to message renderer components via props.
 */
export function renderMarkdown(text: string): string {
  return renderMessage(text);
}
