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
import { and, desc, eq, inArray, or, isNull } from "drizzle-orm";
import { parseProfileAddress, parseWorldAddress, profileAddressPath } from "@yumina/shared";
import { readPublic } from "../db/index.js";
import { user, worlds } from "../db/schema.js";
import { resolveImageCdn } from "./cdn-url.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { cleanMarkdown, stripLeadingTitle } from "./seo-text.js";
import {
  canonicalWorldPath,
  findUserByHandle,
  findWorldByPublicId,
  isPubliclyVisible,
  type AddressedUser,
  type AddressedWorld,
} from "./world-address.js";

const HOME_GRID = 24;
const CREATOR_GRID = 24;
const MORE_FROM_CREATOR = 8;
const MAX_PARAGRAPHS = 8;
const MAX_DESCRIPTION_CHARS = 2400;

export interface WorldCard {
  id: string;
  publicId: string | null;
  name: string;
  thumbnailUrl: string | null;
  creatorName: string | null;
  creatorUsername: string | null;
}

// ── text helpers ─────────────────────────────────────────────────────────────

export function esc(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Creator text as plain paragraphs: markdown removed, blank lines kept as breaks. */
export function markdownToParagraphs(raw: string | null | undefined, name?: string | null): string[] {
  const text = stripLeadingTitle(raw, name);
  if (!text) return [];
  const out: string[] = [];
  let used = 0;
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}|\n(?=\s*(?:[-*+]|\d+\.|#)\s)/)) {
    const clean = cleanMarkdown(block);
    if (!clean) continue;
    if (used + clean.length > MAX_DESCRIPTION_CHARS) {
      const room = MAX_DESCRIPTION_CHARS - used;
      if (room > 80) out.push(`${clean.slice(0, room).replace(/\s+\S*$/, "")}…`);
      break;
    }
    out.push(clean);
    used += clean.length;
    if (out.length >= MAX_PARAGRAPHS) break;
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

function worldHref(card: Pick<WorldCard, "id" | "publicId" | "name" | "creatorUsername">): string {
  return encodeURI(canonicalWorldPath(card) ?? `/app/hub/${card.id}`);
}

function creatorHref(username: string | null | undefined, id?: string): string | null {
  const path = profileAddressPath(username);
  if (path) return encodeURI(path);
  return id ? `/app/users/${encodeURIComponent(id)}` : null;
}

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

export function renderHome(cards: WorldCard[]): string {
  return `<main class="pre pre-home"><h1 class="pre-h1">Discover</h1>${renderGrid(cards)}</main>`;
}

export function renderWorld(world: AddressedWorld, moreFromCreator: WorldCard[]): string {
  const img = coverUrl(world.thumbnailUrl, 896);
  const creator = creatorHref(world.creatorUsername, world.creatorId);
  const byline = world.creatorName
    ? creator
      ? `<p class="pre-by"><a href="${esc(creator)}">${esc(world.creatorName)}</a></p>`
      : `<p class="pre-by">${esc(world.creatorName)}</p>`
    : "";
  const paragraphs = markdownToParagraphs(world.description, world.name)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
  const tags = Array.isArray(world.tags)
    ? (world.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  const tagList = tags.length
    ? `<ul class="pre-tags">${tags.slice(0, 12).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
    : "";
  const more = moreFromCreator.length
    ? `<section class="pre-more">${world.creatorName ? `<h2 class="pre-h2">${esc(world.creatorName)}</h2>` : ""}${renderGrid(moreFromCreator)}</section>`
    : "";
  return (
    `<main class="pre pre-world"><article>` +
    (img ? `<img class="pre-cover" src="${esc(img)}" alt="${esc(world.name)}" width="896" height="1195" />` : "") +
    `<h1 class="pre-h1">${esc(world.name)}</h1>${byline}<div class="pre-text">${paragraphs}</div>${tagList}` +
    `</article>${more}</main>`
  );
}

export function renderCreator(person: AddressedUser, cards: WorldCard[]): string {
  const name = person.name?.trim() || person.username || "";
  const avatar = coverUrl(person.image, 160);
  const bio = markdownToParagraphs(person.bio).map((p) => `<p>${esc(p)}</p>`).join("");
  return (
    `<main class="pre pre-creator"><header class="pre-creator__head">` +
    (avatar ? `<img class="pre-avatar" src="${esc(avatar)}" alt="" width="160" height="160" />` : "") +
    `<h1 class="pre-h1">${esc(name)}</h1>${bio ? `<div class="pre-text">${bio}</div>` : ""}</header>${renderGrid(cards)}</main>`
  );
}

// ── data ─────────────────────────────────────────────────────────────────────

const CARD_COLUMNS = {
  id: worlds.id,
  publicId: worlds.publicId,
  name: worlds.name,
  thumbnailUrl: worlds.thumbnailUrl,
  creatorName: user.name,
  creatorUsername: user.username,
};

const publicWorldFilter = and(
  or(eq(worlds.status, "published"), and(isNull(worlds.status), eq(worlds.isPublished, true))),
  eq(worlds.ageRating, "all"),
  eq(worlds.visibility, "public"),
);

async function topWorlds(limit: number): Promise<WorldCard[]> {
  return readPublic()
    .select(CARD_COLUMNS)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(publicWorldFilter)
    .orderBy(desc(worlds.downloadCount), desc(worlds.updatedAt))
    .limit(limit);
}

async function worldsByCreators(creatorIds: string[], limit: number, excludeId?: string): Promise<WorldCard[]> {
  if (!creatorIds.length) return [];
  const rows = await readPublic()
    .select(CARD_COLUMNS)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(publicWorldFilter, inArray(worlds.creatorId, creatorIds)))
    .orderBy(desc(worlds.downloadCount), desc(worlds.updatedAt))
    .limit(limit + 1);
  return rows.filter((r) => r.id !== excludeId).slice(0, limit);
}

// ── cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { until: number; html: string | null }>();
const CACHE_MAX = 500;
const TTL_HOME_MS = 5 * 60 * 1000;
const TTL_PAGE_MS = 60 * 1000;

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
}

/**
 * The content fragment for a public path, or null when the page gets the
 * empty shell as before. Never throws: a database hiccup means no fragment.
 */
export async function renderPublicContent(rawPath: string): Promise<string | null> {
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") || "/" : rawPath;
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) return hit.html;

  try {
    if (path === "/") {
      return remember(path, renderHome(await topWorlds(HOME_GRID)), TTL_HOME_MS);
    }

    const worldAddress = parseWorldAddress(path);
    if (worldAddress) {
      const world = await findWorldByPublicId(worldAddress.publicId);
      if (!world || !isPubliclyVisible(world) || (world.ageRating ?? "all") !== "all") return remember(path, null, TTL_PAGE_MS);
      const more = await worldsByCreators([world.creatorId], MORE_FROM_CREATOR, world.id);
      return remember(path, renderWorld(world, more), TTL_PAGE_MS);
    }

    const handle = parseProfileAddress(path);
    if (handle) {
      const person = await findUserByHandle(handle);
      if (!person || person.isBanned || person.isSuspended) return remember(path, null, TTL_PAGE_MS);
      const cards = await worldsByCreators([person.id], CREATOR_GRID);
      return remember(path, renderCreator(person, cards), TTL_PAGE_MS);
    }
  } catch {
    return null;
  }
  return null;
}
