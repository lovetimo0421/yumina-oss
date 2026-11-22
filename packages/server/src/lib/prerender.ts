/**
 * Real content in the HTML the server sends for public pages.
 *
 * The app is a single-page app: the shell arrives empty and scripts fill it
 * in. Search engines can run those scripts, but later, in a separate queue,
 * and not always. So for the pages that should be found, the server now puts
 * the page's own words and links into the shell: the home page's grid of
 * worlds, a world's cover, name, creator, description and tags, a creator's
 * page and their worlds. A visitor sees it the instant the page arrives; the
 * app takes over a moment later (main.tsx clears it before mounting).
 *
 * Only data appears here, never slogans. Everything is escaped. Pages that
 * must stay out of search (adult-rated, private, unknown) get nothing.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getKrewPublicPath, parseProfileAddress, parseWorldAddress, tagPagePath, TAG_PAGE_PREFIX } from "@yumina/shared";
import { readPublic } from "../db/index.js";
import { user, worlds } from "../db/schema.js";
import { resolveImageCdn } from "./cdn-url.js";
import { PUBLIC_ORIGIN } from "./env.js";
import {
  CARD_COLUMNS,
  forgetThread,
  isPublicThread,
  isStaffRole,
  loadCommunityIndex,
  loadEventPage,
  loadForumPage,
  loadLandingData,
  loadTagCatalog,
  loadTagPage,
  loadThreadPage,
  loadWorldExtras,
  TAG_SITEMAP_MIN_WORLDS,
  THREAD_REPLIES_PER_PAGE,
  pageTagEntry,
  parsePageParam,
  publicWorldFilter,
  type CommunityIndex,
  type ForumPage,
  type PublicEvent,
  type TagInfo,
  type TagPage,
  type ThreadListItem,
  type ThreadPage,
  type WorldCard,
  type WorldExtras,
} from "./public-pages.js";
import { cleanMarkdown, stripLeadingTitle, summarizeText } from "./seo-text.js";
import { listBlogPosts } from "./blog.js";
import { listPublicUpdates, loadUpdatePage, parseUpdatePath, renderUpdatePage, renderUpdates } from "./updates-public.js";
import { edition } from "../edition/index.js";
import { ATELIER_PATH, atelierPage } from "./atelier-public.js";
import { findLandingPage, landingLinks, renderLanding, type LandingLink } from "./landing-public.js";
import { PRICING_PATH, renderPricing } from "./pricing-public.js";
import { creatorHref, worldHref, worldListHtml } from "./public-page-parts.js";
import { runWithWorldViewer, worldAudienceCondition } from "./world-publication-access.js";
import {
  canonicalWorldPath,
  findUserByHandle,
  findWorldByPublicId,
  isPubliclyVisible,
  type AddressedUser,
  type AddressedWorld,
} from "./world-address.js";

// The most played worlds the home page links, and the newest ones under them.
// New worlds get a link from the strongest page on the day they are published.
const HOME_GRID = 48;
const HOME_NEW = 24;
const CREATOR_GRID = 24;
const MORE_FROM_CREATOR = 8;
// A world's description is shown whole. The caps only bound a pathological
// page (the longest real descriptions are a few thousand characters).
const MAX_PARAGRAPHS = 60;
const MAX_DESCRIPTION_CHARS = 12_000;
const BIO_LIMITS = { paragraphs: 8, chars: 2400 };
const THREAD_LIMITS = { paragraphs: 80, chars: 12_000 };
const REPLY_LIMITS = { paragraphs: 12, chars: 1500 };

export type { WorldCard } from "./public-pages.js";

// ── text helpers ─────────────────────────────────────────────────────────────

export function esc(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Creator text as plain paragraphs: markdown removed, blank lines kept as breaks. */
export function markdownToParagraphs(
  raw: string | null | undefined,
  name?: string | null,
  limits: { paragraphs: number; chars: number } = { paragraphs: MAX_PARAGRAPHS, chars: MAX_DESCRIPTION_CHARS },
): string[] {
  const text = stripLeadingTitle(raw, name);
  if (!text) return [];
  const out: string[] = [];
  let used = 0;
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}|\n(?=\s*(?:[-*+]|\d+\.|#)\s)/)) {
    const clean = cleanMarkdown(block);
    if (!clean) continue;
    if (used + clean.length > limits.chars) {
      const room = limits.chars - used;
      if (room > 80) out.push(`${clean.slice(0, room).replace(/\s+\S*$/, "")}…`);
      break;
    }
    out.push(clean);
    used += clean.length;
    if (out.length >= limits.paragraphs) break;
  }
  return out;
}

/** Edge-resized cover when the origin sits behind Cloudflare; the plain CDN URL elsewhere. */
export function coverUrl(ref: string | null | undefined, width: number): string | null {
  const url = resolveImageCdn(ref);
  if (!url) return null;
  let host = "";
  try {
    host = new URL(PUBLIC_ORIGIN).hostname;
  } catch {
    return url;
  }
  if (!/(^|\.)yumina\.io$/.test(host) || !url.startsWith(`${PUBLIC_ORIGIN}/cdn/`)) return url;
  const path = url.slice(PUBLIC_ORIGIN.length);
  return `${PUBLIC_ORIGIN}/cdn-cgi/image/width=${width},quality=85,format=auto,anim=false,onerror=redirect${path}`;
}

export { worldHref };

// ── pure renderers (tested) ──────────────────────────────────────────────────

function renderCard(card: WorldCard): string {
  const img = coverUrl(card.thumbnailUrl, 480);
  const cover = img
    ? `<img class="pre-card__img" src="${esc(img)}" alt="" loading="lazy" width="480" height="640" />`
    : `<span class="pre-card__img pre-card__img--blank" aria-hidden="true"></span>`;
  const by = card.creatorName ? `<span class="pre-card__by">${esc(card.creatorName)}</span>` : "";
  return `<a class="pre-card" href="${esc(worldHref(card))}">${cover}<span class="pre-card__name">${esc(card.name)}</span>${by}</a>`;
}

export function renderGrid(cards: WorldCard[]): string {
  if (!cards.length) return "";
  return `<div class="pre-grid">${cards.map(renderCard).join("")}</div>`;
}

/** What the home page links to besides the worlds. Each part is left out when it is empty or switched off in this edition. */
export interface HomeLinks {
  /** Tag pages, most worlds first. */
  tags: TagInfo[];
  /** Newest blog posts. */
  posts: Array<{ slug: string; title: string }>;
  /** Newly published worlds, not repeating the grid above. */
  fresh: WorldCard[];
  /** The genre pages (AI RPG, AI roleplay, ...). Empty in an edition without them. */
  browse: LandingLink[];
  pricing: boolean;
  atelier: boolean;
  community: boolean;
}

const HOME_TAGS = 36;
const HOME_POSTS = 8;

/**
 * The home page as a crawler reads it. It is the site's strongest page, so it
 * says what Yumina is and links to every kind of public page: worlds, the tag
 * pages, the Atelier, pricing, the blog, updates and the community. A crawler
 * that lands here can reach the rest of the site without the sitemap.
 */
export function renderHome(cards: WorldCard[], links?: HomeLinks): string {
  const head =
    `<h1 class="pre-h1">Discover</h1><p class="pre-lede">Play and create AI driven games, visual novels, anime characters and simulators.</p>`;
  if (!links) return `<main class="pre pre-home">${head}${renderGrid(cards)}</main>`;
  const about =
    `<div class="pre-text"><p>Creators build the worlds. You step in and play them with AI characters that talk back and remember you. ` +
    `It runs in your browser, on a phone or a computer, and it is built on an open-source AI game engine.</p>` +
    `<p>Playing is free. Every account has a free AI model with no message limit, and you can bring your own key and pay the provider directly.</p></div>`;
  const browse = links.browse.length
    ? `<section class="pre-more"><h2 class="pre-h2">Browse</h2><ul class="pre-tags">${links.browse.map((l) => `<li><a href="${esc(l.path)}">${esc(l.label)}</a></li>`).join("")}</ul></section>`
    : "";
  const tags = links.tags.length
    ? `<section class="pre-more"><h2 class="pre-h2">Browse by tag</h2>${tagLinks(links.tags)}</section>`
    : "";
  const make = [
    links.atelier ? `<li><a href="/atelier">Atelier</a>: make pictures, video, sound and 3D models for a world</li>` : "",
    links.pricing ? `<li><a href="/pricing">Pricing</a>: what is free, and what a plan adds</li>` : "",
    `<li><a href="https://docs.yumina.io/">Docs</a>: how to play, and how to build a world</li>`,
  ].join("");
  const posts = links.posts.length
    ? `<section class="pre-more"><h2 class="pre-h2">From the blog</h2><ul class="pre-list pre-text">${links.posts
        .map((p) => `<li><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></li>`)
        .join("")}</ul><p class="pre-by"><a href="/blog">Every post</a></p></section>`
    : "";
  const more = [
    `<li><a href="/updates">Updates</a>: what changed, newest first</li>`,
    links.community ? `<li><a href="/app/community">Community</a>: forums, events and announcements</li>` : "",
    `<li><a href="https://github.com/lovetimo0421/yumina-oss">Source code</a>: the engine, editor and player, open source</li>`,
  ].join("");
  return (
    `<main class="pre pre-home">${head}${about}${browse}${renderGrid(cards)}` +
    (links.fresh.length ? `<section class="pre-more"><h2 class="pre-h2">New worlds</h2>${renderGrid(links.fresh)}</section>` : "") +
    `${tags}` +
    `<section class="pre-more"><h2 class="pre-h2">Make your own</h2><ul class="pre-list pre-text">${make}</ul></section>` +
    `${posts}<section class="pre-more"><h2 class="pre-h2">More</h2><ul class="pre-list pre-text">${more}</ul></section></main>`
  );
}

/** The links the home page carries. Never throws: a database hiccup only drops the tag list. */
async function homeLinks(shown: WorldCard[]): Promise<HomeLinks> {
  const features = edition.info().features;
  let tags: TagInfo[] = [];
  try {
    tags = [...(await loadTagCatalog()).values()]
      .filter((t) => t.count >= TAG_SITEMAP_MIN_WORLDS)
      .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug))
      .slice(0, HOME_TAGS);
  } catch {
    tags = [];
  }
  let fresh: WorldCard[] = [];
  try {
    fresh = await newestWorlds(HOME_NEW, new Set(shown.map((w) => w.id)));
  } catch {
    fresh = [];
  }
  return {
    tags,
    fresh,
    browse: features.hub ? landingLinks() : [],
    posts: listBlogPosts().slice(0, HOME_POSTS).map((p) => ({ slug: p.slug, title: p.title })),
    pricing: features.billing,
    atelier: features.imageGeneration,
    community: features.community,
  };
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", zh: "中文", "zh-hant": "繁體中文", "zh-tw": "繁體中文", ja: "日本語", es: "Español", ko: "한국어",
  fr: "Français", de: "Deutsch", pt: "Português", ru: "Русский", it: "Italiano", vi: "Tiếng Việt", th: "ไทย", id: "Bahasa Indonesia",
};

/** A language code as readers know it ("zh" → 中文); the code itself when unknown. */
export function languageName(code: string | null | undefined): string {
  const key = (code ?? "").trim().toLowerCase();
  if (!key) return "";
  return LANGUAGE_NAMES[key] ?? LANGUAGE_NAMES[key.split("-")[0]!] ?? code!.trim();
}

function stringTags(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
}

function paragraphsHtml(paragraphs: string[]): string {
  return paragraphs.map((p) => `<p>${esc(p)}</p>`).join("");
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `<time>` with the day in ISO form, which every reader and parser understands. */
function timeTag(value: Date | string | null | undefined): string {
  const iso = isoDate(value);
  return iso ? `<time datetime="${iso}">${iso.slice(0, 10)}</time>` : "";
}

/** A tag as a link to its page when it has one, as plain text otherwise. */
function tagItem(tag: string): string {
  const href = pageTagEntry(tag) ? tagPagePath(tag) : null;
  return href ? `<li><a href="${esc(href)}">${esc(tag)}</a></li>` : `<li>${esc(tag)}</li>`;
}

function worldStats(world: AddressedWorld): string {
  const parts: string[] = [];
  const plays = Number(world.downloadCount ?? 0);
  const reviews = Number(world.reviewCount ?? 0);
  const rating = Number(world.averageRating ?? 0);
  if (plays > 0) parts.push(`${plays.toLocaleString("en-US")} ${plays === 1 ? "play" : "plays"}`);
  if (reviews > 0) {
    const score = rating > 0 ? `${(Math.round(rating * 10) / 10).toFixed(1)} / 5, ` : "";
    parts.push(`${score}${reviews.toLocaleString("en-US")} ${reviews === 1 ? "review" : "reviews"}`);
  }
  return parts.length ? `<p class="pre-by pre-stats">${esc(parts.join(" · "))}</p>` : "";
}

function worldLanguages(world: AddressedWorld, extras: WorldExtras | undefined): string {
  const own = languageName(world.language);
  const others = (extras?.siblings ?? []).flatMap((v) => {
    const path = canonicalWorldPath(v);
    const name = languageName(v.language);
    return path && name ? [`<a href="${esc(encodeURI(path))}" hreflang="${esc(v.language)}">${esc(name)}</a>`] : [];
  });
  if (!own && !others.length) return "";
  return `<p class="pre-by pre-langs">${[own ? esc(own) : "", ...others].filter(Boolean).join(" · ")}</p>`;
}

export function renderWorld(world: AddressedWorld, moreFromCreator: WorldCard[], extras?: WorldExtras): string {
  const img = coverUrl(world.thumbnailUrl, 896);
  const gamePath = getKrewPublicPath(world.gamePath);
  const play = gamePath ? `<p class="pre-by"><a href="${gamePath}">Play Krew.io</a></p>` : "";
  const creator = creatorHref(world.creatorUsername, world.creatorId);
  const byline = world.creatorName
    ? creator
      ? `<p class="pre-by"><a href="${esc(creator)}">${esc(world.creatorName)}</a></p>`
      : `<p class="pre-by">${esc(world.creatorName)}</p>`
    : "";
  const paragraphs = paragraphsHtml(markdownToParagraphs(world.description, world.name));
  const note = extras?.announcement ? paragraphsHtml(markdownToParagraphs(extras.announcement, world.name, BIO_LIMITS)) : "";
  const opening = extras?.opening
    ? `<section class="pre-opening"><h2 class="pre-h2">Opening</h2><div class="pre-text">${paragraphsHtml(extras.opening.split(/\n{2,}/))}</div></section>`
    : "";
  const tags = stringTags(world.tags);
  const tagList = tags.length ? `<ul class="pre-tags">${tags.slice(0, 20).map(tagItem).join("")}</ul>` : "";
  const more = moreFromCreator.length
    ? `<section class="pre-more">${world.creatorName ? `<h2 class="pre-h2">${esc(world.creatorName)}</h2>` : ""}${renderGrid(moreFromCreator)}</section>`
    : "";
  const similar = extras?.similar.length
    ? `<section class="pre-more pre-similar"><h2 class="pre-h2">More like this</h2>${renderGrid(extras.similar)}</section>`
    : "";
  return (
    `<main class="pre pre-world"><article>` +
    (img ? `<img class="pre-cover" src="${esc(img)}" alt="${esc(world.name)}" width="896" height="1195" />` : "") +
    `<h1 class="pre-h1">${esc(world.name)}</h1>${byline}${worldStats(world)}${worldLanguages(world, extras)}` +
    `<div class="pre-text">${paragraphs}${note}</div>${opening}${play}${tagList}` +
    `</article>${more}${similar}</main>`
  );
}

export function renderCreator(person: AddressedUser, cards: WorldCard[]): string {
  const name = person.name?.trim() || person.username || "";
  const avatar = coverUrl(person.image, 160);
  const bio = paragraphsHtml(markdownToParagraphs(person.bio, null, BIO_LIMITS));
  return (
    `<main class="pre pre-creator"><header class="pre-creator__head">` +
    (avatar ? `<img class="pre-avatar" src="${esc(avatar)}" alt="" width="160" height="160" />` : "") +
    `<h1 class="pre-h1">${esc(name)}</h1>${bio ? `<div class="pre-text">${bio}</div>` : ""}</header>${renderGrid(cards)}</main>`
  );
}

// ── tag pages ────────────────────────────────────────────────────────────────

function tagLinks(tags: TagInfo[]): string {
  if (!tags.length) return "";
  return `<ul class="pre-tags">${tags.map((t) => `<li><a href="${esc(`${TAG_PAGE_PREFIX}${t.slug}`)}">${esc(t.label)}</a></li>`).join("")}</ul>`;
}

/** A tag's page: its worlds as links with creator and a line of description, then neighbouring tags. */
export function renderTag(page: TagPage): string {
  const related = page.related.length
    ? `<section class="pre-more"><h2 class="pre-h2">Related tags</h2>${tagLinks(page.related)}</section>`
    : "";
  return (
    `<main class="pre pre-tag"><h1 class="pre-h1">${esc(page.tag.label)}</h1>` +
    `<p class="pre-lede">${page.tag.count.toLocaleString("en-US")} ${page.tag.count === 1 ? "world" : "worlds"}</p>` +
    `${worldListHtml(page.worlds)}${related}</main>`
  );
}

// ── community ────────────────────────────────────────────────────────────────

const threadPath = (id: string) => `/app/community/thread/${encodeURIComponent(id)}`;
const forumPath = (slug: string) => `/app/community/${encodeURIComponent(slug)}`;
const eventPath = (id: string) => `/app/community/events/${encodeURIComponent(id)}`;

function threadList(items: ThreadListItem[], withForum: boolean): string {
  if (!items.length) return "";
  const rows = items
    .map((t) => {
      const meta = [
        t.authorName ? esc(t.authorName) : "",
        withForum ? `<a href="${esc(forumPath(t.forumSlug))}">${esc(t.forumName)}</a>` : "",
        timeTag(t.lastReplyAt ?? t.createdAt),
        t.replyCount > 0 ? `${t.replyCount.toLocaleString("en-US")} ${t.replyCount === 1 ? "reply" : "replies"}` : "",
      ].filter(Boolean);
      return `<li><a href="${esc(threadPath(t.id))}">${esc(t.title)}</a>${meta.length ? ` <span class="pre-card__by">${meta.join(" · ")}</span>` : ""}</li>`;
    })
    .join("");
  return `<ol class="pre-list pre-text">${rows}</ol>`;
}

/** The community's front page: boards, running events, latest threads. */
export function renderCommunity(index: CommunityIndex): string {
  const boards = index.forums.length
    ? `<section class="pre-more"><h2 class="pre-h2">Forums</h2><ul class="pre-list pre-text">${index.forums
        .map((f) => `<li><a href="${esc(forumPath(f.slug))}">${esc(f.name)}</a>${f.description.trim() ? `<p>${esc(cleanMarkdown(f.description))}</p>` : ""}</li>`)
        .join("")}</ul></section>`
    : "";
  const events = index.events.length
    ? `<section class="pre-more"><h2 class="pre-h2">Events</h2><ul class="pre-list pre-text">${index.events
        .map((e) => `<li><a href="${esc(eventPath(e.id))}">${esc(e.title)}</a></li>`)
        .join("")}</ul></section>`
    : "";
  const latest = index.threads.length
    ? `<section class="pre-more"><h2 class="pre-h2">Latest threads</h2>${threadList(index.threads, true)}</section>`
    : "";
  return `<main class="pre pre-community"><h1 class="pre-h1">Community</h1>${boards}${events}${latest}</main>`;
}

/** A board: its name, its own description, its threads. */
export function renderForum(page: ForumPage): string {
  const about = page.forum.description.trim() ? `<p class="pre-lede">${esc(cleanMarkdown(page.forum.description))}</p>` : "";
  return (
    `<main class="pre pre-forum"><p class="pre-by"><a href="/app/community">Community</a></p>` +
    `<h1 class="pre-h1">${esc(page.forum.name)}</h1>${about}${threadList(page.threads, false)}</main>`
  );
}

function authorLine(name: string | null, username: string | null, id: string, when: Date | null, role?: string | null): string {
  const href = creatorHref(username, id);
  const who = name ? (href ? `<a href="${esc(href)}">${esc(name)}</a>` : esc(name)) : "";
  const staff = isStaffRole(role) ? `<span class="pre-staff">Staff</span>` : "";
  return [who, staff, timeTag(when)].filter(Boolean).join(" · ");
}

/** A thread page's address on this site: the plain one for page 1, `?page=N` after it. */
function threadPageHref(id: string, page: number): string {
  return page > 1 ? `${threadPath(id)}?page=${page}` : threadPath(id);
}

/**
 * One page of a thread. Page 1 is the post in full and the first replies;
 * a later page repeats the headline (linked to page 1) and carries its own
 * replies. Replies are flat, oldest first, each with author, date and text.
 * Previous / next are real links a crawler can follow; there is no
 * all-replies view. User-written links are rendered as their text, so no
 * link in a post is followable.
 */
export function renderThread(page: ThreadPage): string {
  const { thread, replies } = page;
  if (!isPublicThread(thread)) return "";
  const first = page.page <= 1;
  const replyHtml = replies
    .map((r) => {
      const text = paragraphsHtml(markdownToParagraphs(r.content, null, REPLY_LIMITS));
      if (!text) return "";
      return `<li id="reply-${esc(String(r.floor))}"><p class="pre-by">${authorLine(r.authorName, r.authorUsername, r.authorId, r.createdAt, r.authorRole)}</p><div class="pre-text">${text}</div></li>`;
    })
    .join("");
  const count = page.replyTotal;
  const repliesBlock = replyHtml
    ? `<section class="pre-more"><h2 class="pre-h2">${count.toLocaleString("en-US")} ${count === 1 ? "reply" : "replies"}</h2><ol class="pre-list" start="${(page.page - 1) * THREAD_REPLIES_PER_PAGE + 1}">${replyHtml}</ol></section>`
    : "";
  const pager = page.pageCount > 1
    ? `<nav class="pre-by pre-pager">` +
      [
        page.page > 1 ? `<a rel="prev" href="${esc(threadPageHref(thread.id, page.page - 1))}">Previous page</a>` : "",
        `Page ${page.page} of ${page.pageCount}`,
        page.page < page.pageCount ? `<a rel="next" href="${esc(threadPageHref(thread.id, page.page + 1))}">Next page</a>` : "",
      ].filter(Boolean).join(" · ") +
      `</nav>`
    : "";
  const crumbs = `<p class="pre-by"><a href="/app/community">Community</a> · <a href="${esc(forumPath(thread.forumSlug))}">${esc(thread.forumName)}</a></p>`;
  const byline = `<p class="pre-by">${authorLine(thread.authorName, thread.authorUsername, thread.authorId, thread.createdAt, thread.authorRole)}</p>`;
  if (!first) {
    return (
      `<main class="pre pre-thread"><article>${crumbs}` +
      `<h1 class="pre-h1"><a href="${esc(threadPath(thread.id))}">${esc(thread.title)}</a></h1>${byline}</article>${repliesBlock}${pager}</main>`
    );
  }
  const body = paragraphsHtml(markdownToParagraphs(thread.content, thread.title, THREAD_LIMITS));
  // The worlds the post shares, each a link to the world's own page.
  const shared = page.worlds.length
    ? `<section class="pre-more pre-shared"><h2 class="pre-h2">${page.worlds.length === 1 ? "World in this post" : "Worlds in this post"}</h2>${renderGrid(page.worlds)}</section>`
    : "";
  return (
    `<main class="pre pre-thread"><article>${crumbs}` +
    `<h1 class="pre-h1">${esc(thread.title)}</h1>${byline}` +
    `<div class="pre-text">${body}</div></article>${shared}${repliesBlock}${pager}</main>`
  );
}

/** An event: its title, when it runs, what it is, what it gives. */
export function renderEvent(event: PublicEvent): string {
  const opens = timeTag(event.registrationOpensAt);
  const closes = timeTag(event.registrationClosesAt);
  const dates = opens || closes ? `<p class="pre-by">${[opens, closes].filter(Boolean).join(" – ")}</p>` : "";
  const reward = event.rewardDescription?.trim()
    ? `<section class="pre-more"><h2 class="pre-h2">Rewards</h2><div class="pre-text">${paragraphsHtml(markdownToParagraphs(event.rewardDescription, null, THREAD_LIMITS))}</div></section>`
    : "";
  return (
    `<main class="pre pre-event"><article><p class="pre-by"><a href="/app/community">Community</a></p>` +
    `<h1 class="pre-h1">${esc(event.title)}</h1>${dates}` +
    `<div class="pre-text">${paragraphsHtml(markdownToParagraphs(event.introduction, event.title, THREAD_LIMITS))}</div></article>${reward}</main>`
  );
}

// ── data ─────────────────────────────────────────────────────────────────────

async function topWorlds(limit: number): Promise<WorldCard[]> {
  return readPublic()
    .select(CARD_COLUMNS)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(publicWorldFilter, worldAudienceCondition(worlds.creatorId)))
    .orderBy(desc(worlds.downloadCount), desc(worlds.updatedAt))
    .limit(limit);
}

/** The most recently published public, all-ages worlds, leaving out the ones already shown. */
async function newestWorlds(limit: number, exclude: Set<string>): Promise<WorldCard[]> {
  const rows = await readPublic()
    .select(CARD_COLUMNS)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(publicWorldFilter, worldAudienceCondition(worlds.creatorId)))
    .orderBy(desc(worlds.publishedAt), desc(worlds.updatedAt))
    .limit(limit + exclude.size);
  return rows.filter((r) => !exclude.has(r.id)).slice(0, limit);
}

async function worldsByCreators(creatorIds: string[], limit: number, excludeId?: string): Promise<WorldCard[]> {
  if (!creatorIds.length) return [];
  const rows = await readPublic()
    .select(CARD_COLUMNS)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(publicWorldFilter, inArray(worlds.creatorId, creatorIds), worldAudienceCondition(worlds.creatorId)))
    .orderBy(desc(worlds.downloadCount), desc(worlds.updatedAt))
    .limit(limit + 1);
  return rows.filter((r) => r.id !== excludeId).slice(0, limit);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** First segments under /app/community that are app pages, not board slugs. */
export const COMMUNITY_RESERVED = new Set(["new", "tag", "events", "thread"]);

// ── cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { until: number; html: string | null }>();
const CACHE_MAX = 500;
const TTL_HOME_MS = 5 * 60 * 1000;
const TTL_PAGE_MS = 60 * 1000;
// Same as the blog's Cache-Control max-age (routes/blog.ts HTML_CACHE).
const TTL_UPDATES_MS = 5 * 60 * 1000;

function remember(key: string, html: string | null, ttl: number): string | null {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { until: Date.now() + ttl, html });
  return html;
}

/** For tests and admin tooling. */
export function clearPrerenderCache(): void {
  cache.clear();
  featured = null;
}

let featured: { until: number; cards: WorldCard[] } | null = null;

/**
 * The most played public, all-ages worlds, for pages that point readers at
 * something to play (the blog). Cached like the home grid. Never throws: a
 * database hiccup means an empty list and the page renders without the block.
 */
export async function featuredWorldCards(limit: number): Promise<WorldCard[]> {
  if (featured && featured.until > Date.now() && featured.cards.length >= limit) return featured.cards.slice(0, limit);
  try {
    const cards = await topWorlds(limit);
    featured = { until: Date.now() + TTL_HOME_MS, cards };
    return cards;
  } catch {
    return [];
  }
}

/** Drop the rendered pages of one thread and of the community lists it appears in (this process only). */
export function forgetThreadPages(threadId: string): void {
  const own = `/app/community/thread/${threadId}`;
  for (const key of [...cache.keys()]) {
    if (key === own || key.startsWith(`${own}?`) || (key.startsWith("/app/community") && !key.startsWith("/app/community/thread/"))) cache.delete(key);
  }
  forgetThread(threadId);
}

/**
 * The content fragment for a public path, or null when the page gets the
 * empty shell as before. Never throws: a database hiccup means no fragment.
 */
export async function renderPublicContent(rawPath: string, query: { page?: string | null } = {}): Promise<string | null> {
  // Fragments are cached by path and shared with anonymous visitors. Keep
  // privileged owner/admin content out even on an authenticated page request.
  return runWithWorldViewer(undefined, async () => {
    const bare = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") || "/" : rawPath;
    // Only a thread has pages; every other query parameter is the same page.
    const threadPageNo = bare.startsWith("/app/community/thread/") ? parsePageParam(query.page) : 1;
    const path = threadPageNo > 1 ? `${bare}?page=${threadPageNo}` : bare;
    const hit = cache.get(path);
    if (hit && hit.until > Date.now()) return hit.html;

    try {
      if (path === "/") {
        const top = await topWorlds(HOME_GRID);
        return remember(path, renderHome(top, await homeLinks(top)), TTL_HOME_MS);
      }

      // The update log: public entries only, in English, for the same five
      // minutes the blog lets a page be cached.
      if (path === "/updates") {
        return remember(path, renderUpdates(await listPublicUpdates()), TTL_UPDATES_MS);
      }

      // One update-log entry: its own page, public entries only.
      if (parseUpdatePath(path)) {
        const entry = await loadUpdatePage(path);
        return remember(path, entry ? renderUpdatePage(entry) : null, TTL_UPDATES_MS);
      }

      // Pricing and the Atelier pages are built from constants, so they are
      // cached only to save the string work.
      const lower = path.toLowerCase();
      if (lower === PRICING_PATH) {
        return remember(path, edition.info().features.billing ? renderPricing() : null, TTL_UPDATES_MS);
      }
      if (lower === ATELIER_PATH || lower.startsWith(`${ATELIER_PATH}/`)) {
        const page = edition.info().features.imageGeneration ? atelierPage(lower) : null;
        return remember(path, page ? page.html : null, TTL_UPDATES_MS);
      }

      // The genre pages (/ai-rpg and the rest): fixed words around a list of
      // worlds that changes, so they are cached like the home grid.
      const landing = findLandingPage(lower);
      if (landing) {
        if (!edition.info().features.hub) return remember(path, null, TTL_HOME_MS);
        return remember(path, renderLanding(landing, await loadLandingData(landing.slug, landing.tags)), TTL_HOME_MS);
      }

      const worldAddress = parseWorldAddress(path);
      if (worldAddress) {
        const world = await findWorldByPublicId(worldAddress.publicId);
        if (!world || !isPubliclyVisible(world) || (world.ageRating ?? "all") !== "all") return remember(path, null, TTL_PAGE_MS);
        const [more, extras] = await Promise.all([
          worldsByCreators([world.creatorId], MORE_FROM_CREATOR, world.id),
          loadWorldExtras(world),
        ]);
        return remember(path, renderWorld(world, more, extras), TTL_PAGE_MS);
      }

      const handle = parseProfileAddress(path);
      if (handle) {
        const person = await findUserByHandle(handle);
        if (!person || person.isBanned || person.isSuspended) return remember(path, null, TTL_PAGE_MS);
        const cards = await worldsByCreators([person.id], CREATOR_GRID);
        return remember(path, renderCreator(person, cards), TTL_PAGE_MS);
      }

      // The loaders below keep their own cache (lib/public-pages.ts), shared
      // with the page's meta tags; the rendered HTML is kept here as well.
      if (path.startsWith(TAG_PAGE_PREFIX)) {
        const page = await loadTagPage(path.slice(TAG_PAGE_PREFIX.length));
        return remember(path, page ? renderTag(page) : null, TTL_PAGE_MS);
      }

      if (path === "/app/community") {
        return remember(path, renderCommunity(await loadCommunityIndex()), TTL_PAGE_MS);
      }

      const thread = /^\/app\/community\/thread\/([^/]+)$/.exec(bare);
      if (thread) {
        const page = UUID_RE.test(thread[1]!) ? await loadThreadPage(thread[1]!, threadPageNo) : null;
        return remember(path, page ? renderThread(page) || null : null, TTL_PAGE_MS);
      }

      const event = /^\/app\/community\/events\/([^/]+)$/.exec(path);
      if (event) {
        const found = UUID_RE.test(event[1]!) ? await loadEventPage(event[1]!) : null;
        return remember(path, found ? renderEvent(found) : null, TTL_PAGE_MS);
      }

      const forum = /^\/app\/community\/([a-z0-9-]+)$/.exec(path);
      if (forum && !COMMUNITY_RESERVED.has(forum[1]!)) {
        const page = await loadForumPage(forum[1]!);
        return remember(path, page ? renderForum(page) : null, TTL_PAGE_MS);
      }
    } catch {
      return null;
    }
    return null;
  });
}
