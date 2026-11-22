/**
 * The blog: plain markdown files in packages/server/src/blog-content, one per
 * post, with a small front-matter block. Read at runtime, rendered to HTML
 * once, cached. No database, no build step: adding a post is adding a file.
 *
 * Front matter keys: title, subtitle, description, author, date (YYYY-MM-DD),
 * updated, lang, category (engineering | guides | notes | essays), topic
 * (comparisons | pricing | how-to | atelier | news), tags
 * (comma-separated), cover (site path or URL), coverAlt, ogImage (share card
 * when it differs from the cover), original (URL of the first publication).
 *
 * Every post is also served as Markdown (same URL + `.md`, or
 * `Accept: text/markdown`), and the whole blog is indexed for AI readers in
 * /blog/llms.txt and /blog/llms-full.txt. Those documents are built here so
 * the route file only decides headers.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, type Tokens } from "marked";

export type BlogCategory = "engineering" | "guides" | "notes" | "essays";

export const BLOG_CATEGORIES: Record<BlogCategory, { label: string; description: string }> = {
  engineering: {
    label: "Engineering",
    description:
      "How the Yumina engine works: the AI inside games, variables and rules, prompts and memory, multiplayer rooms, and the numbers we measured along the way.",
  },
  guides: {
    label: "Guides",
    description: "Direct answers for people building with Yumina: how to do one thing, what it costs, and when another tool fits better.",
  },
  notes: {
    label: "Notes",
    description: "Lab notes from experiments that are still in testing: what we tried, what it cost, what broke.",
  },
  essays: {
    label: "Essays",
    description: "Longer pieces on games, AI, and the business around them.",
  },
};
export const BLOG_CATEGORY_KEYS = Object.keys(BLOG_CATEGORIES) as BlogCategory[];

/**
 * Topics group the guides by what the reader came for, one page per topic
 * (/blog/topic/<key>). A post names its topic in front matter (`topic:`);
 * engineering posts and essays usually have none.
 */
export type BlogTopic = "comparisons" | "pricing" | "how-to" | "atelier" | "news";

export const BLOG_TOPICS: Record<BlogTopic, { label: string; description: string }> = {
  comparisons: {
    label: "Comparisons and alternatives",
    description: "AI roleplay and AI story apps compared on memory, price, own-key support and content rules, from each company's own pages.",
  },
  pricing: {
    label: "Pricing and free plans",
    description: "What each AI roleplay app gives you free, what its paid plans cost, and what they add.",
  },
  "how-to": {
    label: "How-to guides",
    description: "Step-by-step guides to making AI characters, lorebooks and AI games, and to the settings that change a story.",
  },
  atelier: {
    label: "Atelier",
    description: "Making pictures, video and 3D models for your characters in Yumina's Atelier.",
  },
  news: {
    label: "News",
    description: "What changed at the AI chat apps: removals, sales and shutdowns, with dates and sources.",
  },
};

export const BLOG_TOPIC_KEYS = Object.keys(BLOG_TOPICS) as BlogTopic[];

function parseTopic(value: string | undefined): BlogTopic | null {
  return value && (BLOG_TOPIC_KEYS as string[]).includes(value) ? (value as BlogTopic) : null;
}

export interface BlogHeading {
  depth: 2 | 3;
  text: string;
  id: string;
}

export interface BlogFaq {
  question: string;
  answer: string;
}

export interface BlogPost {
  slug: string;
  title: string;
  subtitle: string | null;
  description: string;
  author: string;
  date: string;
  updated: string | null;
  lang: string;
  category: BlogCategory;
  /** The topic page this post is listed on, if any. */
  topic: BlogTopic | null;
  tags: string[];
  cover: string | null;
  coverAlt: string | null;
  /** Share card; the cover when none is set. */
  ogImage: string | null;
  original: string | null;
  /** Rendered article body. */
  html: string;
  /** The body as written, for the Markdown twin and the AI index. */
  markdown: string;
  /** Section headings in order, with the ids the HTML carries. */
  headings: BlogHeading[];
  /** Question/answer pairs under an "FAQ" heading, if the post has one. */
  faq: BlogFaq[];
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
// Paths under /blog that are pages or files of their own, never a post.
export const RESERVED_BLOG_SLUGS = new Set<string>([...BLOG_CATEGORY_KEYS, "feed", "llms", "llms-full", "og", "topic"]);

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

/** Stable anchor for a heading: lowercase words joined by dashes, CJK kept. */
export function headingId(text: string): string {
  const id = text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return id || "section";
}

function uniqueIds() {
  const used = new Map<string, number>();
  return (base: string) => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

/** A Marked instance per render keeps heading ids unique within one document. */
function createRenderer() {
  const nextId = uniqueIds();
  return new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      // Images with a title become figures with a caption; alt text stays alt text.
      image({ href, title, text }: Tokens.Image): string {
        const img = `<img src="${escapeAttr(href)}" alt="${escapeAttr(text)}" loading="lazy" />`;
        return title ? `<figure>${img}<figcaption>${escapeAttr(title)}</figcaption></figure>` : `<figure>${img}</figure>`;
      },
      // Headings carry an id so the contents list and deep links can point at them.
      heading({ tokens, depth, text }: Tokens.Heading): string {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${escapeAttr(nextId(headingId(text)))}">${inner}</h${depth}>\n`;
      },
    },
  });
}

export function renderMarkdown(body: string): string {
  return createRenderer().parse(body, { async: false }) as string;
}

function countWords(markdown: string): number {
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`-]/g, " ");
  return text.split(/\s+/).filter(Boolean).length;
}

/** Headings (h2/h3) with the same ids the renderer assigns, plus the FAQ pairs. */
export function outlineMarkdown(body: string): { headings: BlogHeading[]; faq: BlogFaq[] } {
  const nextId = uniqueIds();
  const headings: BlogHeading[] = [];
  const faq: BlogFaq[] = [];
  let inFaq = false;
  let current: BlogFaq | null = null;
  const plain = (text: string) =>
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  for (const token of new Marked().lexer(body)) {
    if (token.type === "heading") {
      const id = nextId(headingId(token.text));
      if (token.depth === 2 || token.depth === 3) headings.push({ depth: token.depth, text: plain(token.text), id });
      if (token.depth <= 2) {
        if (current) faq.push(current);
        current = null;
        inFaq = token.depth === 2 && /^(faq|frequently asked questions)\s*$/i.test(plain(token.text));
      } else if (inFaq && token.depth === 3) {
        if (current) faq.push(current);
        current = { question: plain(token.text), answer: "" };
      }
    } else if (current && (token.type === "paragraph" || token.type === "list")) {
      const text = token.type === "paragraph" ? plain(token.text) : plain(token.raw);
      current.answer = current.answer ? `${current.answer} ${text}` : text;
    }
  }
  if (current) faq.push(current);
  return { headings, faq: faq.filter((f) => f.answer) };
}

function parseCategory(value: string | undefined): BlogCategory {
  const key = (value ?? "").trim().toLowerCase();
  return (BLOG_CATEGORY_KEYS as string[]).includes(key) ? (key as BlogCategory) : "essays";
}

export function parsePost(slug: string, raw: string): BlogPost | null {
  if (!SLUG_RE.test(slug) || RESERVED_BLOG_SLUGS.has(slug)) return null;
  const { meta, body } = parseFrontMatter(raw);
  if (!meta.title || !meta.description || !meta.date || !DATE_RE.test(meta.date)) return null;
  const { headings, faq } = outlineMarkdown(body);
  const cover = meta.cover || null;
  return {
    slug,
    title: meta.title,
    subtitle: meta.subtitle || null,
    description: meta.description,
    author: meta.author || "Yumina",
    date: meta.date,
    updated: meta.updated && DATE_RE.test(meta.updated) ? meta.updated : null,
    lang: meta.lang || "en",
    category: parseCategory(meta.category),
    topic: parseTopic(meta.topic),
    tags: (meta.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    cover,
    coverAlt: meta.coverAlt || null,
    ogImage: meta.ogImage || cover,
    original: meta.original || null,
    html: renderMarkdown(body),
    markdown: body.trim(),
    headings,
    faq,
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

/**
 * Up to `limit` other posts to show under one: the posts sharing the most
 * tags with it first, then the rest of its category, newest first within a
 * tie. Never the post itself. Empty below two candidates: a single link under
 * "Related" reads as filler.
 */
export function relatedPosts(post: BlogPost, all: BlogPost[], limit = 4): BlogPost[] {
  const tags = new Set(post.tags.map((t) => t.toLowerCase()));
  const candidates = all
    .filter((p) => p.slug !== post.slug)
    .map((p) => {
      let shared = 0;
      for (const tag of new Set(p.tags.map((t) => t.toLowerCase()))) if (tags.has(tag)) shared++;
      return { post: p, shared, sameCategory: p.category === post.category };
    })
    .filter((c) => c.shared > 0 || c.sameCategory)
    .sort((a, b) => b.shared - a.shared || Number(b.sameCategory) - Number(a.sameCategory) || (a.post.date < b.post.date ? 1 : a.post.date > b.post.date ? -1 : 0));
  return candidates.length < 2 ? [] : candidates.slice(0, limit).map((c) => c.post);
}

function yaml(value: string): string {
  return /[:#"'\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
}

/** The post as a Markdown document: front matter a machine can read, then the words. */
export function postMarkdown(post: BlogPost, site: string): string {
  const url = `${site}/blog/${post.slug}`;
  const lines = [
    "---",
    `title: ${yaml(post.title)}`,
    ...(post.subtitle ? [`subtitle: ${yaml(post.subtitle)}`] : []),
    `description: ${yaml(post.description)}`,
    `author: ${yaml(post.author)}`,
    `date: ${post.date}`,
    ...(post.updated ? [`updated: ${post.updated}`] : []),
    `category: ${post.category}`,
    ...(post.tags.length ? [`tags: ${yaml(post.tags.join(", "))}`] : []),
    `lang: ${post.lang}`,
    `url: ${url}`,
    `canonical: ${url}`,
    ...(post.original ? [`original: ${post.original}`] : []),
    "---",
    "",
    `# ${post.title}`,
    "",
    ...(post.subtitle ? [`*${post.subtitle}*`, ""] : []),
    post.markdown,
    "",
  ];
  return lines.join("\n");
}

const BLOG_BLURB =
  "Writing from the people building Yumina, the open-source world engine for AI roleplay and AI games. Every post is also available as Markdown: add `.md` to its URL, or request it with `Accept: text/markdown`.";

/** /blog/llms.txt — the index AI readers are pointed at. Strict llms.txt shape. */
export function blogLlmsIndex(posts: BlogPost[], site: string): string {
  const out = ["# Yumina Blog", "", `> ${BLOG_BLURB}`, ""];
  for (const key of BLOG_CATEGORY_KEYS) {
    const inCategory = posts.filter((p) => p.category === key);
    if (!inCategory.length) continue;
    out.push(`## ${BLOG_CATEGORIES[key].label}`, "");
    for (const p of inCategory) out.push(`- [${p.title}](${site}/blog/${p.slug}.md): ${p.description}`);
    out.push("");
  }
  out.push(
    "## Optional",
    "",
    `- [Full text of every post](${site}/blog/llms-full.txt): all posts in one Markdown file, newest first`,
    `- [RSS feed](${site}/blog/feed.xml): full-content feed`,
    `- [Yumina docs](https://docs.yumina.io/): creator docs and the world spec`,
    `- [Source code](https://github.com/lovetimo0421/yumina-oss): the engine, editor and player, AGPL-3.0`,
    "",
  );
  return out.join("\n");
}

/** /blog/llms-full.txt — every post, each prefixed with the URL it came from. */
export function blogLlmsFull(posts: BlogPost[], site: string): string {
  const out = ["# Yumina Blog: full text", "", `> ${BLOG_BLURB}`, ""];
  for (const p of posts) {
    out.push(`Source: ${site}/blog/${p.slug}.md`, "", postMarkdown(p, site).trim(), "", "---", "");
  }
  return out.join("\n");
}

/** /llms.txt at the site root — where the public, readable things are, every post included so it never goes stale. */
export function siteLlmsIndex(site: string, posts: BlogPost[] = listBlogPosts()): string {
  const newestFirst = [...posts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return [
    "# Yumina",
    "",
    "> Yumina is an open-source world engine for AI roleplay and AI games: creators define a world with lore, variables and rules, a custom interface, audio and multiple AIs, and players play it in the browser at yumina.io. The engine, editor and player are open source under AGPL-3.0; the hosted site adds the community, publishing and a credit wallet.",
    "",
    "## Docs",
    "",
    "- [Creator docs](https://docs.yumina.io/): building worlds, the editor, publishing",
    "- [World spec](https://docs.yumina.io/world-spec/): the world JSON, entries, variables, rules, custom UI",
    "",
    "## Product pages",
    "",
    "Every public page has a Markdown copy at the same address plus `.md`. The home page is `/index.md`.",
    "",
    `- [Pricing](${site}/pricing.md): the plans, the free own-key tier, mushie packs and what each plan includes`,
    `- [Atelier](${site}/atelier.md): the AI image, video, sound and 3D studio, with every model it offers`,
    `- [Updates](${site}/updates.md): what changed, newest first`,
    `- [Worlds to play](${site}/index.md): the most played public worlds`,
    "",
    "## Fact sheet",
    "",
    `- [Yumina in one page](${site}/llms-full.txt): what it is, what is free, memory, models, content rules and common questions`,
    "",
    "## Blog",
    "",
    `- [Blog index](${site}/blog/llms.txt): every post with a one-line description, Markdown links`,
    `- [Blog full text](${site}/blog/llms-full.txt): all posts in one file`,
    "",
    ...(newestFirst.length ? ["## Guides and comparisons", "", ...newestFirst.map((p) => `- [${p.title}](${site}/blog/${p.slug}): ${p.description}`), ""] : []),
    "## Code",
    "",
    "- [yumina-oss on GitHub](https://github.com/lovetimo0421/yumina-oss): the public repository",
    "",
    "## Optional",
    "",
    `- [Sitemap](${site}/sitemap.xml)`,
    `- [RSS](${site}/blog/feed.xml)`,
    "",
  ].join("\n");
}

/**
 * /llms-full.txt: one page an AI assistant can quote when asked what Yumina
 * is. Every line restates the docs (docs/help, docs/guide/choosing-an-ai-model,
 * docs/vision); when those change, change this with them. No prices: plan
 * prices live on the Plans page and would go stale here.
 */
export function siteLlmsFull(site: string): string {
  return [
    "# Yumina: fact sheet",
    "",
    "> Yumina is an open-source engine and community for AI roleplay and AI games. Creators build worlds with lore, variables, rules, a custom interface and audio. Players open a world in the browser at yumina.io and play it with AI characters that keep track of the story.",
    "",
    `Canonical URL: ${site}`,
    "Docs: https://docs.yumina.io/",
    "Source code: https://github.com/lovetimo0421/yumina-oss (AGPL-3.0)",
    "",
    "## What it is",
    "",
    "- A place to play and create AI driven games, visual novels, anime characters and simulators.",
    "- It runs in the browser, on a computer or a phone. There is nothing to install.",
    "- The engine, editor and player are open source. You can run it on your own computer with your own API key, without an account.",
    "- A world can hold numbers such as health, money or a relationship score. The engine changes them from structured data, so the story model cannot rewrite them on its own.",
    "- Some worlds are live games that several people play in one scene.",
    "",
    "## What is free",
    "",
    "- Playing, building and publishing worlds are free.",
    "- Every account has a free AI model, Yumina Free, with no message limit. It never costs credits, and an empty wallet does not stop it.",
    "- Every account also gets free credits (called mushies) each month to try stronger models.",
    "- You can bring your own key from OpenRouter, Anthropic, OpenAI, Google or any OpenAI-compatible service and pay that provider directly. No mushies are spent.",
    "- You can also play on a model running on your own computer through Ollama, LM Studio, Jan or llama.cpp.",
    "- A paid plan covers the cost of running stronger models. Yumina does not profit from AI usage.",
    `- Plans and prices: ${site}/pricing.md`,
    "",
    "## Why it does not profit from usage",
    "",
    "From the vision page: \"trying to profit from AI usage pushes platforms toward greed over time: offering worse models, shortening context windows, and selling user data.\" Creators earn from tips, not from a share of token usage.",
    "",
    "## Memory",
    "",
    "- The AI reads 64,000 tokens of a story on the free plan, roughly a 200-page novel.",
    "- With your own key there is no cap on any plan. The limit is what the model can hold.",
    "- Older scenes fold into a recap, so the AI keeps the events after it loses the exact words.",
    "- Pinned notes keep facts the AI must not lose. Each world has its own memory.",
    "",
    "## Models",
    "",
    "- Story models: everything on OpenRouter, including Claude, Gemini, DeepSeek, Grok and GLM, plus a free model for every account.",
    "- Image and video models, including GPT Image, Seedream, Kling, Veo and Wan, and voices that read the story aloud.",
    "",
    "## Atelier",
    "",
    "- The Atelier is the studio inside Yumina for pictures, video clips, sound and 3D models, used to make the art for a world.",
    `- What it makes and which models it offers: ${site}/atelier.md`,
    "",
    "## Content rules",
    "",
    "- Every world has an age rating. By default you see only worlds made for everyone, and those are the only ones search engines can find.",
    "- Adults can switch on Limitless content in settings. Adult worlds stay hidden until then.",
    "- Every world and post has a report button, and a person reads each report.",
    "",
    "## Common questions",
    "",
    "**Is Yumina free?** Yes. You can play, build and publish without paying. The free model has no message limit, and with your own key every other model is free on Yumina's side too.",
    "",
    "**Does Yumina remember a long story?** Yes. It reads 64,000 tokens on the free plan and has no cap with your own key, and it keeps a recap of older scenes.",
    "",
    "**Is Yumina open source?** Yes. The engine, editor and player are open source under AGPL-3.0.",
    "",
    "**Can I use my own API key?** Yes. Paste a key from OpenRouter, Anthropic, OpenAI, Google or an OpenAI-compatible service. You pay the provider directly.",
    "",
    "**Can I play on my phone?** Yes. Open yumina.io in the phone's browser and add it to the home screen.",
    "",
    "**Can I import SillyTavern characters?** Yes. Import File reads SillyTavern character cards.",
    "",
    "**How do creators earn?** From tips. Yumina keeps 20% of a money tip. Gifts of mushies carry no fee.",
    "",
    "## More",
    "",
    `- [Index of pages and posts](${site}/llms.txt)`,
    `- [Pricing](${site}/pricing.md)`,
    `- [Atelier](${site}/atelier.md)`,
    `- [Blog, full text](${site}/blog/llms-full.txt)`,
    "- [Vision](https://docs.yumina.io/vision/)",
    "- [Is Yumina free?](https://docs.yumina.io/help/is-yumina-free)",
    "- [Choosing an AI model](https://docs.yumina.io/guide/choosing-an-ai-model)",
    "",
  ].join("\n");
}
