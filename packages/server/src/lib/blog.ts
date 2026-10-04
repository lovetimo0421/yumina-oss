/**
 * The blog: plain markdown files in packages/server/src/blog-content, one per
 * post, with a small front-matter block. Read at runtime, rendered to HTML
 * once, cached. No database, no build step: adding a post is adding a file.
 *
 * Front matter keys: title, subtitle, description, author, date (YYYY-MM-DD),
 * updated, lang, cover (site path or URL), coverAlt, original (URL of the
 * first publication, if any).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, type Tokens } from "marked";

export interface BlogPost {
  slug: string;
  title: string;
  subtitle: string | null;
  description: string;
  author: string;
  date: string;
  updated: string | null;
  lang: string;
  cover: string | null;
  coverAlt: string | null;
  original: string | null;
  /** Rendered article body. */
  html: string;
  /** Plain-text word count of the body, for reading time. */
  words: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Dev: src/lib → ../blog-content. Prod: dist → ../src/blog-content (the
// Dockerfile copies the folder there). Last: a plain cwd fallback.
const CANDIDATE_DIRS = [
  path.resolve(__dirname, "../blog-content"),
  path.resolve(__dirname, "../src/blog-content"),
  path.resolve(process.cwd(), "src/blog-content"),
];

export function blogContentDir(): string | null {
  for (const dir of CANDIDATE_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `---` block of `key: value` lines, quotes optional. Returns the rest as body. */
export function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: match[2] ?? "" };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Images with a title become figures with a caption; alt text stays alt text.
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    image({ href, title, text }: Tokens.Image): string {
      const img = `<img src="${escapeAttr(href)}" alt="${escapeAttr(text)}" loading="lazy" />`;
      return title ? `<figure>${img}<figcaption>${escapeAttr(title)}</figcaption></figure>` : `<figure>${img}</figure>`;
    },
  },
});

export function renderMarkdown(body: string): string {
  return marked.parse(body, { async: false }) as string;
}

function countWords(markdown: string): number {
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`-]/g, " ");
  return text.split(/\s+/).filter(Boolean).length;
}

export function parsePost(slug: string, raw: string): BlogPost | null {
  if (!SLUG_RE.test(slug)) return null;
  const { meta, body } = parseFrontMatter(raw);
  if (!meta.title || !meta.description || !meta.date || !DATE_RE.test(meta.date)) return null;
  return {
    slug,
    title: meta.title,
    subtitle: meta.subtitle || null,
    description: meta.description,
    author: meta.author || "Yumina",
    date: meta.date,
    updated: meta.updated && DATE_RE.test(meta.updated) ? meta.updated : null,
    lang: meta.lang || "en",
    cover: meta.cover || null,
    coverAlt: meta.coverAlt || null,
    original: meta.original || null,
    html: renderMarkdown(body),
    words: countWords(body),
  };
}

let cache: { at: number; posts: BlogPost[] } | null = null;
const CACHE_MS = process.env.NODE_ENV === "production" ? 5 * 60 * 1000 : 0;

/** Every post, newest first. Empty when the content folder is absent (open-source edition). */
export function listBlogPosts(): BlogPost[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.posts;
  const dir = blogContentDir();
  const posts: BlogPost[] = [];
  if (dir) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const post = parsePost(file.slice(0, -3), fs.readFileSync(path.join(dir, file), "utf8"));
        if (post) posts.push(post);
      } catch {
        // a broken file hides itself, never the whole blog
      }
    }
  }
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  cache = { at: now, posts };
  return posts;
}

export function getBlogPost(slug: string): BlogPost | null {
  return listBlogPosts().find((p) => p.slug === slug) ?? null;
}

export function readingMinutes(post: BlogPost): number {
  return Math.max(1, Math.round(post.words / 220));
}
