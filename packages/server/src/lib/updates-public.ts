/**
 * yumina.io/updates for crawlers and feed readers.
 *
 * The page itself is the app shell (the app forwards to /app/updates). The
 * server puts the public entries into that shell the way lib/prerender.ts
 * does for the home page, so a crawler reads real words instead of an empty
 * root. The same list feeds /updates/feed.xml and dates /updates in the
 * sitemap.
 *
 * Public entries only, exactly what a logged-out reader of /api/changelog
 * gets (visibleEntries with no viewer): never internal, hidden or
 * unrestricted ones.
 *
 * Every public entry also has a page of its own: /updates/<id> in English and
 * /updates/<id>/<lang> for each other language the entry was written in.
 * /updates is the index that links to them.
 */
import type { Context, Hono } from "hono";
import { CHANGELOG_LANGS, type ChangelogEntryView, type ChangelogLang } from "@yumina/shared";
import { sharedChangelogStore, visibleEntries, type ChangelogStore, type MergedChangelogEntry } from "./changelog-store.js";
import { PUBLIC_ORIGIN } from "./env.js";

const SITE = PUBLIC_ORIGIN;
export const UPDATES_TITLE = "Updates";
export const UPDATES_DESCRIPTION = "What's new in Yumina: features, improvements and fixes, newest first.";
// Newest first; a crawler and a feed reader both want the recent ones.
const UPDATES_IN_HTML = 100;
const UPDATES_IN_FEED = 50;
// The blog's HTML_CACHE (routes/blog.ts).
const FEED_CACHE = "public, max-age=300, stale-while-revalidate=3600";

function esc(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Public entries, newest first, in English. */
export async function listPublicUpdates(store: ChangelogStore = sharedChangelogStore()): Promise<ChangelogEntryView[]> {
  return visibleEntries(await store.list(false), { isAdmin: false }, "en");
}

/** YYYY-MM-DD of the newest public entry (the sitemap's lastmod); undefined when there is none or the list fails. */
export async function newestPublicUpdateDate(store?: ChangelogStore): Promise<string | undefined> {
  try {
    let newest: string | undefined;
    for (const e of await listPublicUpdates(store)) if (!newest || e.date > newest) newest = e.date;
    return newest;
  } catch {
    return undefined;
  }
}

/** The address of an entry's own page: /updates/<id> in English, /updates/<id>/<lang> otherwise. */
export function updatePath(id: string, lang: ChangelogLang = "en"): string {
  return lang === "en" ? `/updates/${id}` : `/updates/${id}/${lang}`;
}

/**
 * The #root fragment for /updates: the index. Each entry is its title (a link
 * to its own page), its date and its opening words; the full text lives on
 * the entry's page.
 */
export function renderUpdates(entries: ChangelogEntryView[]): string {
  const items = entries
    .slice(0, UPDATES_IN_HTML)
    .map(
      (e) =>
        `<article class="pre-update" id="${esc(e.id)}"><h2 class="pre-h2"><a href="${esc(updatePath(e.id))}">${esc(e.title)}</a></h2>` +
        `<time datetime="${esc(e.date)}">${esc(e.date)}</time><div class="pre-text"><p>${summary(e.html)}</p></div></article>`,
    )
    .join("");
  return `<main class="pre pre-updates"><h1 class="pre-h1">${esc(UPDATES_TITLE)}</h1>${items || "<p>No updates yet.</p>"}</main>`;
}

// ── One page per entry ───────────────────────────────────────────────────────

/** Public entries with every language they were written in, newest first. */
export async function listPublicUpdateEntries(store: ChangelogStore = sharedChangelogStore()): Promise<MergedChangelogEntry[]> {
  return (await store.list(false)).filter((e) => !e.hidden && e.audience === "public");
}

/** The languages an entry has a page in: English first, then the others it carries a title and text for. */
export function updateLanguages(entry: Pick<MergedChangelogEntry, "title" | "html">): ChangelogLang[] {
  const has = (lang: ChangelogLang) => Boolean(entry.title[lang]?.trim() && entry.html[lang]?.trim());
  return [...(has("en") ? (["en"] as ChangelogLang[]) : []), ...CHANGELOG_LANGS.filter((lang) => lang !== "en" && has(lang))];
}

export interface UpdatePage {
  id: string;
  date: string;
  areas: readonly string[];
  lang: ChangelogLang;
  title: string;
  html: string;
  /** Every language this entry has a page in, this one included. */
  languages: ChangelogLang[];
  /** The entry published after this one, and the one before it, in this language when they have it. */
  newer: { id: string; title: string; lang: ChangelogLang } | null;
  older: { id: string; title: string; lang: ChangelogLang } | null;
}

/** `/updates/<id>` or `/updates/<id>/<lang>` as its parts; null for any other path. */
export function parseUpdatePath(path: string): { id: string; lang: string | null } | null {
  const match = /^\/updates\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (!match || match[1] === "feed.xml") return null;
  return { id: match[1]!, lang: match[2] ?? null };
}

/**
 * The page for one entry in one language, from the public list. Null when the
 * entry is not public, does not exist, or was not written in that language
 * (a language falls back nowhere here: a fallback page would be a copy of
 * another page).
 */
export function findUpdatePage(entries: MergedChangelogEntry[], id: string, rawLang: string | null): UpdatePage | null {
  const index = entries.findIndex((e) => e.id === id);
  if (index < 0) return null;
  const entry = entries[index]!;
  const languages = updateLanguages(entry);
  const lang = rawLang === null ? "en" : CHANGELOG_LANGS.find((l) => l.toLowerCase() === rawLang.toLowerCase());
  // English lives at /updates/<id>; /updates/<id>/en is not a second address for it.
  if (!lang || !languages.includes(lang) || (rawLang !== null && lang === "en")) return null;
  const neighbour = (other: MergedChangelogEntry | undefined) => {
    if (!other) return null;
    const theirs = updateLanguages(other);
    const use = theirs.includes(lang) ? lang : theirs[0];
    return use ? { id: other.id, title: other.title[use]!, lang: use } : null;
  };
  return {
    id: entry.id,
    date: entry.date,
    areas: entry.areas,
    lang,
    title: entry.title[lang]!,
    html: entry.html[lang]!,
    languages,
    newer: neighbour(entries[index - 1]),
    older: neighbour(entries[index + 1]),
  };
}

/** An entry page by path (public entries only). */
export async function loadUpdatePage(path: string, store?: ChangelogStore): Promise<UpdatePage | null> {
  const parts = parseUpdatePath(path);
  return parts ? findUpdatePage(await listPublicUpdateEntries(store), parts.id, parts.lang) : null;
}

const LANGUAGE_LABELS: Record<ChangelogLang, string> = { en: "English", zh: "简体中文", "zh-Hant": "繁體中文", es: "Español", ja: "日本語" };

/** The #root fragment for one entry: title, date, text, the other languages, the next and previous entry. */
export function renderUpdatePage(page: UpdatePage): string {
  const others = page.languages.filter((lang) => lang !== page.lang);
  const langs = others.length
    ? `<p class="pre-by">${others.map((lang) => `<a href="${esc(updatePath(page.id, lang))}" hreflang="${esc(lang)}" lang="${esc(lang)}">${esc(LANGUAGE_LABELS[lang])}</a>`).join(" · ")}</p>`
    : "";
  const link = (rel: "next" | "prev", label: string, to: UpdatePage["newer"]) =>
    to ? `<a rel="${rel}" href="${esc(updatePath(to.id, to.lang))}">${label}: ${esc(to.title)}</a>` : "";
  const around = [link("prev", "Older", page.older), link("next", "Newer", page.newer)].filter(Boolean).join(" · ");
  return (
    `<main class="pre pre-update-page"><p class="pre-by"><a href="/updates">${esc(UPDATES_TITLE)}</a></p>` +
    `<article lang="${esc(page.lang)}"><h1 class="pre-h1">${esc(page.title)}</h1>` +
    `<p class="pre-by"><time datetime="${esc(page.date)}">${esc(page.date)}</time></p>` +
    `<div class="pre-text">${page.html}</div></article>${langs}` +
    (around ? `<nav class="pre-by pre-pager">${around}</nav>` : "") +
    `</main>`
  );
}

/** The entry's words as one plain line, for the meta description (decoded: the caller escapes). */
export function updateDescription(html: string, max = 160): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[·•]\s*/g, "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text;
}

/** Relative site links become absolute so the feed reads outside the site. */
function absoluteHtml(html: string): string {
  return html.replace(/(src|href)="\/(?!\/)/g, `$1="${SITE}/`);
}

/** The entry's words without markup, cut short. The text is already entity-escaped by the renderer. */
function summary(html: string): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/</g, "&lt;").trim();
  return text.length > 300 ? `${text.slice(0, 300).replace(/\s+\S*$/, "")}…` : text;
}

/** RSS 2.0, built like /blog/feed.xml: title, link, date, areas as categories, the full entry as content. */
export function updatesFeed(entries: ChangelogEntryView[]): string {
  const shown = entries.slice(0, UPDATES_IN_FEED);
  const items = shown
    .map(
      (e) => `  <item>
    <title>${esc(e.title)}</title>
    <link>${SITE}${updatePath(e.id)}</link>
    <guid isPermaLink="true">${SITE}/updates#${esc(e.id)}</guid>
    <pubDate>${new Date(`${e.date}T00:00:00Z`).toUTCString()}</pubDate>
${e.areas.map((a) => `    <category>${esc(a)}</category>\n`).join("")}    <description>${summary(e.html)}</description>
    <content:encoded><![CDATA[${absoluteHtml(e.html).replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></content:encoded>
  </item>`,
    )
    .join("\n");
  const latest = shown.reduce((d, e) => (e.date > d ? e.date : d), "1970-01-01");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Yumina Updates</title>
  <link>${SITE}/updates</link>
  <atom:link href="${SITE}/updates/feed.xml" rel="self" type="application/rss+xml" />
  <description>${esc(UPDATES_DESCRIPTION)}</description>
  <language>en</language>
  <lastBuildDate>${new Date(`${latest}T00:00:00Z`).toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`;
}

function sendFeed(c: Context, xml: string) {
  c.header("Content-Type", "application/rss+xml; charset=utf-8");
  c.header("Cache-Control", FEED_CACHE);
  return c.body(xml);
}

/** /updates/feed.xml. The /updates page needs no route: the app shell carries the prerendered entries. */
export function mountUpdatesRoutes(app: Hono, store: ChangelogStore = sharedChangelogStore()): void {
  app.get("/updates/feed.xml", async (c) => sendFeed(c, updatesFeed(await listPublicUpdates(store))));
}
