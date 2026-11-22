/**
 * Markdown copies of the public pages.
 *
 * Every page that carries real content for crawlers (lib/prerender.ts) is also
 * served as Markdown at the same address plus ".md" ("/" is "/index.md"), or
 * at the same address when the client asks for text/markdown ahead of HTML.
 * The blog has done this per post since it launched (lib/blog.ts); this is the
 * same contract for the rest of the site: front matter a machine can read,
 * then the words, with a canonical Link header back to the page.
 *
 * The Markdown is derived from the page's own HTML fragment, so the two can
 * never say different things, and a page with no fragment (private, adult,
 * noindex or missing) has no Markdown copy either.
 */
import { PUBLIC_ORIGIN } from "./env.js";
import { renderPublicContent } from "./prerender.js";
import { getMetaForPath, type PageMeta } from "./seo.js";

// ── a small tree for the fragments our own renderers write ──────────────────

interface El {
  tag: string;
  attrs: Record<string, string>;
  kids: Node[];
}
type Node = El | string;

const VOID = new Set(["img", "br", "hr", "meta", "link", "input"]);
const SKIP = new Set(["script", "style", "svg", "template"]);
const BLOCK = new Set(["main", "section", "div", "article", "nav", "header", "footer", "aside", "figure", "figcaption", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tr", "th", "td", "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "details", "summary", "hr"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, kids: [] };
  const stack: El[] = [root];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  let skipping: string | null = null;
  for (let m = token.exec(html); m; m = token.exec(html)) {
    const top = stack[stack.length - 1]!;
    const [, close, open, rawAttrs, selfClosing, text] = m;
    if (skipping) {
      if (close?.toLowerCase() === skipping) skipping = null;
      continue;
    }
    if (text !== undefined) {
      top.kids.push(decode(text));
    } else if (open) {
      const tag = open.toLowerCase();
      if (SKIP.has(tag)) {
        if (!selfClosing) skipping = tag;
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of (rawAttrs ?? "").matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g)) {
        attrs[a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      }
      const el: El = { tag, attrs, kids: [] };
      top.kids.push(el);
      if (!VOID.has(tag) && !selfClosing) stack.push(el);
    } else if (close) {
      const tag = close.toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
    }
  }
  return root;
}

// ── rendering ────────────────────────────────────────────────────────────────

const isEl = (n: Node): n is El => typeof n !== "string";
const squash = (text: string) => text.replace(/\s+/g, " ");

function absolute(href: string, site: string): string {
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("#")) return href;
  return `${site}${href.startsWith("/") ? "" : "/"}${href}`;
}

/** Text as it may sit inside a Markdown line: the characters that would start markup are escaped. */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, "\\$1").replace(/</g, "&lt;");
}

function inline(nodes: Node[], site: string): string {
  let out = "";
  for (const node of nodes) {
    if (!isEl(node)) {
      out += escapeInline(squash(node));
      continue;
    }
    if (node.tag === "br") out += "\n";
    else if (node.tag === "img") out += node.attrs.alt ? `![${escapeInline(squash(node.attrs.alt))}](${absolute(node.attrs.src ?? "", site)})` : "";
    else if (node.tag === "a") out += link(node, site);
    else if (node.tag === "strong" || node.tag === "b") out += wrap("**", inline(node.kids, site));
    else if (node.tag === "em" || node.tag === "i") out += wrap("*", inline(node.kids, site));
    else if (node.tag === "code") out += `\`${textOf(node).replace(/`/g, "'")}\``;
    else out += inline(node.kids, site);
  }
  return out;
}

function wrap(mark: string, inner: string): string {
  const text = inner.trim();
  return text ? `${mark}${text}${mark}` : "";
}

function textOf(node: Node): string {
  return isEl(node) ? node.kids.map(textOf).join("") : node;
}

/**
 * A link. A card (a link holding several labelled parts: a cover, a name, a
 * creator) becomes one link with the parts joined, so a grid of cards reads as
 * a list of names and not a run-on line.
 */
function link(a: El, site: string): string {
  const parts = a.kids.some((k) => isEl(k) && BLOCK.has(k.tag)) || a.kids.filter((k) => isEl(k) && k.tag === "span").length > 1
    ? a.kids.map((k) => (isEl(k) && k.tag === "img" ? "" : squash(inline([k], site)).trim())).filter(Boolean)
    : [squash(inline(a.kids.filter((k) => !(isEl(k) && k.tag === "img" && !k.attrs.alt)), site)).trim()];
  const label = parts.join(" · ");
  const href = a.attrs.href;
  if (!label) return "";
  return href ? `[${label}](${absolute(href, site)})` : label;
}

function cell(node: El, site: string): string {
  return squash(inline(node.kids, site)).trim().replace(/\|/g, "\\|");
}

function table(el: El, site: string): string {
  const rows: El[] = [];
  const collect = (n: El) => {
    for (const k of n.kids) {
      if (!isEl(k)) continue;
      if (k.tag === "tr") rows.push(k);
      else if (k.tag === "thead" || k.tag === "tbody" || k.tag === "tfoot") collect(k);
    }
  };
  collect(el);
  const cells = rows.map((r) => r.kids.filter(isEl).filter((k) => k.tag === "th" || k.tag === "td").map((k) => cell(k, site)));
  const width = Math.max(0, ...cells.map((r) => r.length));
  if (!width) return "";
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const [head, ...body] = cells;
  return [line(head!), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

function list(el: El, site: string, depth: number): string {
  const ordered = el.tag === "ol";
  let n = 0;
  const lines: string[] = [];
  for (const li of el.kids.filter(isEl).filter((k) => k.tag === "li")) {
    n++;
    const nested = li.kids.filter(isEl).filter((k) => k.tag === "ul" || k.tag === "ol");
    const own = li.kids.filter((k) => !(isEl(k) && (k.tag === "ul" || k.tag === "ol")));
    const text = squash(blocks(own, site, depth + 1).join(" ")).trim();
    lines.push(`${"  ".repeat(depth)}${ordered ? `${n}.` : "-"} ${text}`);
    for (const sub of nested) lines.push(list(sub, site, depth + 1));
  }
  return lines.join("\n");
}

/** The blocks of a run of nodes, in order. Loose text and inline elements between blocks become paragraphs. */
function blocks(nodes: Node[], site: string, depth = 0): string[] {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (!run.length) return;
    // Several links in a row with nothing between them are a grid of cards.
    const links = run.filter((n) => isEl(n) && n.tag === "a");
    const rest = run.filter((n) => !(isEl(n) && n.tag === "a")).map(textOf).join("").trim();
    if (links.length > 1 && !rest) out.push(links.map((a) => `- ${link(a as El, site)}`).filter((l) => l !== "- ").join("\n"));
    else {
      const text = inline(run, site).replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
      if (text) out.push(text);
    }
    run = [];
  };
  for (const node of nodes) {
    if (!isEl(node) || !BLOCK.has(node.tag)) {
      run.push(node);
      continue;
    }
    flush();
    const tag = node.tag;
    if (/^h[1-6]$/.test(tag)) {
      const text = squash(inline(node.kids, site)).trim();
      if (text) out.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    } else if (tag === "p" || tag === "summary" || tag === "figcaption") {
      const text = inline(node.kids, site).replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
      if (text) out.push(text);
    } else if (tag === "ul" || tag === "ol") {
      const text = list(node, site, depth);
      if (text) out.push(text);
    } else if (tag === "table") {
      const text = table(node, site);
      if (text) out.push(text);
    } else if (tag === "dt") {
      const text = squash(inline(node.kids, site)).trim();
      if (text) out.push(`**${text}**`);
    } else if (tag === "blockquote") {
      out.push(blocks(node.kids, site, depth).join("\n\n").replace(/^/gm, "> "));
    } else if (tag === "pre") {
      out.push(`\`\`\`\n${textOf(node).replace(/\n+$/, "")}\n\`\`\``);
    } else if (tag === "hr") {
      out.push("---");
    } else {
      out.push(...blocks(node.kids, site, depth));
    }
  }
  flush();
  return out;
}

/** The words of one of our own HTML fragments, as Markdown. Site-relative links become absolute. */
export function fragmentToMarkdown(html: string, site: string = PUBLIC_ORIGIN): string {
  return `${blocks(parse(html).kids, site).join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

// ── the copy of a page ───────────────────────────────────────────────────────

function yaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim()}"`;
}

/** Front matter, then the page's words. The first heading is the page's own H1; nothing is repeated above it. */
export function pageMarkdown(meta: Pick<PageMeta, "title" | "description" | "url" | "lang">, fragment: string, site: string = PUBLIC_ORIGIN): string {
  const front = ["---", `title: ${yaml(meta.title)}`, `description: ${yaml(meta.description)}`, `url: ${meta.url}`, ...(meta.lang ? [`lang: ${meta.lang}`] : []), "---", ""];
  return `${front.join("\n")}\n${fragmentToMarkdown(fragment, site)}`;
}

/** "/pricing.md" is the copy of "/pricing"; "/index.md" is the copy of "/". Null when the path is not a ".md" address. */
export function markdownSourcePath(path: string): string | null {
  if (!path.endsWith(".md")) return null;
  const bare = path.slice(0, -3);
  if (bare === "/index") return "/";
  return bare && bare !== "/" && !bare.endsWith("/") ? bare : null;
}

/** The address of a page's Markdown copy. */
export function markdownTwinPath(path: string): string {
  const bare = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return bare === "/" || bare === "" ? "/index.md" : `${bare}.md`;
}

/** True when the client asks for Markdown ahead of HTML (an agent sending `Accept: text/markdown`). */
export function asksForMarkdown(accept: string | undefined): boolean {
  if (!accept) return false;
  const types = accept.split(",").map((part) => part.split(";")[0]!.trim().toLowerCase());
  const md = types.indexOf("text/markdown");
  if (md < 0) return false;
  const html = types.indexOf("text/html");
  return html < 0 || md < html;
}

export interface PageCopy {
  markdown: string;
  /** The page this is a copy of, for the canonical Link header. */
  canonical: string;
}

/**
 * The Markdown copy of a public page, or null when it has none: the page is
 * kept out of search, resolves to nothing, or carries no content of its own.
 * Same anonymous-viewer rules as the HTML, because it is built from it.
 */
export async function publicPageMarkdown(path: string, query: { page?: string | null; search?: boolean } = {}): Promise<PageCopy | null> {
  const meta = await getMetaForPath(path, query);
  if (meta.noindex || meta.status) return null;
  const fragment = await renderPublicContent(path, query);
  if (!fragment) return null;
  return { markdown: pageMarkdown(meta, fragment), canonical: meta.url };
}
