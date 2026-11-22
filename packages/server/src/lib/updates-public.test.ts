import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { Hono } from "hono";
import { ensureTables } from "../db/index.js";
import { changelogDir, loadChangelog, parseChangelogEntry } from "./changelog.js";
import { createChangelogStore } from "./changelog-store.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { renderPublicContent } from "./prerender.js";
import { buildUpdateMeta, getMetaForPath, injectContent, injectMeta, updateSitemapUrls } from "./seo.js";
import { findUpdatePage, listPublicUpdateEntries, listPublicUpdates, mountUpdatesRoutes, newestPublicUpdateDate, parseUpdatePath, renderUpdatePage, renderUpdates, updateLanguages, updatePath, updatesFeed } from "./updates-public.js";

const template = readFileSync(new URL("../../../app/index.html", import.meta.url), "utf8");

const entry = (file: string, audience: "public" | "internal" | "unrestricted", en: string) =>
  parseChangelogEntry(
    file,
    `---\ndate: ${file.slice(0, 10)}\naudience: ${audience}\nareas: [chat]\ntitle:\n  zh: 标题 ${file}\n  en: ${en}\n---\n## zh\n· 内容\n\n## en\n· Body of ${en} with a [link](/app/community) & more\n`,
  );
const ENTRIES = [
  entry("2026-10-13-adults-only.md", "unrestricted", "Adults only tip"),
  entry("2026-10-12-team-only.md", "internal", "Team only migration"),
  entry("2026-10-11-hello.md", "public", "Hello, players"),
  entry("2026-10-01-older.md", "public", "An older note"),
];
const store = createChangelogStore({ files: () => ENTRIES });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

before(() => ensureTables());

test("the /updates shell carries the public entries' English titles and words; internal and unrestricted ones never appear", async () => {
  const views = await listPublicUpdates(store);
  assert.deepEqual(views.map((v) => [v.id, v.lang]), [["2026-10-11-hello", "en"], ["2026-10-01-older", "en"]]);

  const meta = await getMetaForPath("/updates");
  assert.equal(meta.title, "Updates");
  assert.equal(meta.url, `${PUBLIC_ORIGIN}/updates`);
  assert.equal(meta.noindex, undefined);
  assert.equal((await getMetaForPath("/app/updates")).url, `${PUBLIC_ORIGIN}/updates`, "the app's address points at the shared one");

  const html = injectContent(injectMeta(template, meta), renderUpdates(views));
  assert.match(html, /<title>Updates<\/title>/);
  assert.ok(html.includes(`<link rel="canonical" href="${PUBLIC_ORIGIN}/updates" />`));
  assert.ok(html.includes(`<meta name="description" content="What's new in Yumina: features, improvements and fixes, newest first." />`));
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<div id="root"><main class="pre pre-updates"><h1 class="pre-h1">Updates<\/h1>/);
  // The index: each entry is a link to its own page, its date and its opening words.
  assert.match(html, /<article class="pre-update" id="2026-10-11-hello"><h2 class="pre-h2"><a href="\/updates\/2026-10-11-hello">Hello, players<\/a><\/h2><time datetime="2026-10-11">2026-10-11<\/time><div class="pre-text"><p>Body of Hello, players with a link &amp; more<\/p>/);
  assert.match(html, /An older note/);
  assert.doesNotMatch(html, /Team only|Adults only|team-only|adults-only/);
  assert.doesNotMatch(html, /noindex/);

  assert.equal(renderUpdates([]), `<main class="pre pre-updates"><h1 class="pre-h1">Updates</h1><p>No updates yet.</p></main>`);
  assert.equal(await newestPublicUpdateDate(store), "2026-10-11", "the sitemap's lastmod for /updates");
});

test("/updates/feed.xml is RSS 2.0 of the same public entries, with absolute links and the blog's cache", async () => {
  const app = new Hono();
  mountUpdatesRoutes(app, store);
  const res = await app.request("http://x/updates/feed.xml");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/rss\+xml/);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300, stale-while-revalidate=3600");
  const xml = await res.text();
  assert.equal(xml, updatesFeed(await listPublicUpdates(store)));
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0" /);
  assert.ok(xml.includes(`<atom:link href="${PUBLIC_ORIGIN}/updates/feed.xml" rel="self" type="application/rss+xml" />`));
  assert.ok(xml.includes(`<link>${PUBLIC_ORIGIN}/updates</link>`));
  assert.ok(xml.includes(`<lastBuildDate>${new Date("2026-10-11T00:00:00Z").toUTCString()}</lastBuildDate>`));
  const items = xml.split("<item>").slice(1);
  assert.equal(items.length, 2);
  assert.match(items[0]!, /<title>Hello, players<\/title>/);
  assert.ok(items[0]!.includes(`<link>${PUBLIC_ORIGIN}/updates/2026-10-11-hello</link>`), "an item links to the entry's own page");
  assert.ok(items[0]!.includes(`<guid isPermaLink="true">${PUBLIC_ORIGIN}/updates#2026-10-11-hello</guid>`));
  assert.ok(items[0]!.includes(`<pubDate>${new Date("2026-10-11T00:00:00Z").toUTCString()}</pubDate>`));
  assert.match(items[0]!, /<category>chat<\/category>/);
  assert.match(items[0]!, /<description>Body of Hello, players with a link &amp; more<\/description>/);
  assert.match(items[0]!, /<content:encoded><!\[CDATA\[<ul>/);
  assert.ok(items[0]!.includes(`href="${PUBLIC_ORIGIN}/app/community"`), "feed links are absolute");
  assert.doesNotMatch(xml, /href="\/app/);
  assert.doesNotMatch(xml, /Team only|Adults only/);
});

// ── one page per entry ───────────────────────────────────────────────────────

const multi = parseChangelogEntry(
  "2026-10-20-three-tongues.md",
  `---\ndate: 2026-10-20\naudience: public\nareas: [chat, image]\ntitle:\n  zh: 三种语言\n  en: Three <tongues>\n  ja: 三つの言葉\n---\n## zh\n· 中文内容\n\n## en\n· English body & "quotes"\n\n## ja\n· 日本語の本文\n`,
);
const pageStore = createChangelogStore({ files: () => [multi, ...ENTRIES] });

test("an entry's address is /updates/<id> in English and /updates/<id>/<lang> in its other languages", () => {
  assert.equal(updatePath("2026-10-20-three-tongues"), "/updates/2026-10-20-three-tongues");
  assert.equal(updatePath("2026-10-20-three-tongues", "zh-Hant"), "/updates/2026-10-20-three-tongues/zh-Hant");
  assert.deepEqual(parseUpdatePath("/updates/2026-10-20-three-tongues/ja"), { id: "2026-10-20-three-tongues", lang: "ja" });
  assert.deepEqual(parseUpdatePath("/updates/2026-10-20-three-tongues"), { id: "2026-10-20-three-tongues", lang: null });
  for (const other of ["/updates", "/updates/feed.xml", "/updates/a/b/c", "/app/updates/x"]) assert.equal(parseUpdatePath(other), null, other);
  // English first, then only the languages the entry was written in.
  assert.deepEqual(updateLanguages(multi), ["en", "zh", "ja"]);
});

test("only public entries have a page; a language the entry lacks, and /en, are not pages", async () => {
  const entries = await listPublicUpdateEntries(pageStore);
  assert.deepEqual(entries.map((e) => e.id), ["2026-10-20-three-tongues", "2026-10-11-hello", "2026-10-01-older"]);
  assert.equal(findUpdatePage(entries, "2026-10-12-team-only", null), null, "internal");
  assert.equal(findUpdatePage(entries, "2026-10-13-adults-only", null), null, "unrestricted");
  assert.equal(findUpdatePage(entries, "no-such-entry", null), null);
  assert.equal(findUpdatePage(entries, "2026-10-20-three-tongues", "es"), null, "not written in Spanish: no copy of another page");
  assert.equal(findUpdatePage(entries, "2026-10-20-three-tongues", "en"), null, "English lives at the plain address");
  assert.equal(findUpdatePage(entries, "2026-10-20-three-tongues", "xx"), null);
  assert.equal(findUpdatePage(entries, "2026-10-20-three-tongues", "JA")?.lang, "ja");
});

test("an entry page carries its title, date, text, its other languages and the entries before and after it", async () => {
  const entries = await listPublicUpdateEntries(pageStore);
  const middle = findUpdatePage(entries, "2026-10-11-hello", null)!;
  assert.deepEqual(middle.newer, { id: "2026-10-20-three-tongues", title: "Three <tongues>", lang: "en" });
  assert.deepEqual(middle.older, { id: "2026-10-01-older", title: "An older note", lang: "en" });
  const html = renderUpdatePage(middle);
  assert.match(html, /^<main class="pre pre-update-page"><p class="pre-by"><a href="\/updates">Updates<\/a><\/p><article lang="en"><h1 class="pre-h1">Hello, players<\/h1><p class="pre-by"><time datetime="2026-10-11">2026-10-11<\/time><\/p>/);
  assert.match(html, /Body of Hello, players with a <a href="\/app\/community">link<\/a> &amp; more/);
  assert.match(html, /<a rel="prev" href="\/updates\/2026-10-01-older">Older: An older note<\/a> · <a rel="next" href="\/updates\/2026-10-20-three-tongues">Newer: Three &lt;tongues&gt;<\/a>/);
  assert.match(html, /hreflang="zh"/, "its Chinese version is linked");

  // The Japanese page links its neighbours in Japanese where they have it, in English where they do not.
  const ja = findUpdatePage(entries, "2026-10-20-three-tongues", "ja")!;
  assert.equal(ja.title, "三つの言葉");
  assert.equal(ja.newer, null);
  assert.deepEqual(ja.older, { id: "2026-10-11-hello", title: "Hello, players", lang: "en" });
  const jaHtml = renderUpdatePage(ja);
  assert.match(jaHtml, /<article lang="ja"><h1 class="pre-h1">三つの言葉<\/h1>/);
  assert.match(jaHtml, /<a href="\/updates\/2026-10-20-three-tongues" hreflang="en" lang="en">English<\/a> · <a href="\/updates\/2026-10-20-three-tongues\/zh" hreflang="zh" lang="zh">简体中文<\/a>/);
  assert.doesNotMatch(jaHtml, /rel="next"/);
});

test("entry meta is self-canonical with hreflang for each language and Article structured data", async () => {
  const entries = await listPublicUpdateEntries(pageStore);
  const meta = buildUpdateMeta(findUpdatePage(entries, "2026-10-20-three-tongues", "zh")!);
  assert.equal(meta.title, "三种语言");
  assert.equal(meta.url, `${PUBLIC_ORIGIN}/updates/2026-10-20-three-tongues/zh`);
  assert.equal(meta.lang, "zh");
  assert.equal(meta.description, "中文内容");
  assert.deepEqual(meta.alternates, [
    { lang: "en", url: `${PUBLIC_ORIGIN}/updates/2026-10-20-three-tongues` },
    { lang: "zh", url: `${PUBLIC_ORIGIN}/updates/2026-10-20-three-tongues/zh` },
    { lang: "ja", url: `${PUBLIC_ORIGIN}/updates/2026-10-20-three-tongues/ja` },
  ]);
  const graph = (meta.jsonLd as { "@graph": Array<Record<string, any>> })["@graph"];
  const article = graph.find((n) => n["@type"] === "Article")!;
  assert.equal(article.headline, "三种语言");
  assert.equal(article.datePublished, "2026-10-20");
  assert.equal(article.inLanguage, "zh");
  assert.deepEqual(article.articleSection, ["chat", "image"]);
  assert.equal(graph.find((n) => n["@type"] === "BreadcrumbList")!.itemListElement.length, 3);
  const html = injectMeta(template, meta);
  assert.match(html, /<html lang="zh"/);
  assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${PUBLIC_ORIGIN}/updates/2026-10-20-three-tongues" />`), "English is the default");
  // A title with markup in it cannot break the page or the script tag.
  const en = injectMeta(template, buildUpdateMeta(findUpdatePage(entries, "2026-10-20-three-tongues", null)!));
  assert.match(en, /<title>Three &lt;tongues&gt;<\/title>/);
  assert.doesNotMatch(en, /<tongues>/);
  // An entry in one language has no alternates.
  const single = parseChangelogEntry("2026-10-21-solo.md", `---\ndate: 2026-10-21\naudience: public\nareas: [chat]\ntitle:\n  zh: 独\n  en: Solo\n---\n## zh\n· 内\n\n## en\n· Body\n`);
  assert.equal(updateLanguages({ title: { en: single.title.en }, html: { en: single.html.en } }).length, 1);
});

test("the sitemap lists every language of every public entry with its date and its alternates", async () => {
  const urls = updateSitemapUrls(await listPublicUpdateEntries(pageStore));
  const locs = urls.map((u) => /<loc>([^<]+)<\/loc>/.exec(u.xml)![1]);
  assert.deepEqual(locs.slice(0, 3), [
    `${PUBLIC_ORIGIN}/updates/2026-10-20-three-tongues`,
    `${PUBLIC_ORIGIN}/updates/2026-10-20-three-tongues/zh`,
    `${PUBLIC_ORIGIN}/updates/2026-10-20-three-tongues/ja`,
  ]);
  assert.equal(urls[0]!.lastmod, "2026-10-20");
  assert.ok(urls[0]!.xml.includes(`<xhtml:link rel="alternate" hreflang="ja" href="${PUBLIC_ORIGIN}/updates/2026-10-20-three-tongues/ja" />`));
  assert.ok(!locs.some((l) => /team-only|adults-only/.test(l!)), "internal and unrestricted entries are never listed");
  assert.equal(locs.length, 3 + 2 + 2, "three public entries: one in three languages, two in two");
});

// The open-source export leaves changelog/ out; everywhere else it must be found.
const NO_FOLDER = changelogDir() ? false : "no changelog/ folder (open-source export)";

test("the real folder's newest public entry reaches the prerendered /updates; its internal entries do not", { skip: NO_FOLDER }, async () => {
  const fragment = await renderPublicContent("/updates");
  assert.ok(fragment, "a fragment for /updates");
  assert.match(fragment!, /^<main class="pre pre-updates"><h1 class="pre-h1">Updates<\/h1>/);
  const { entries } = loadChangelog();
  const newest = entries.find((e) => e.audience === "public")!;
  assert.ok(fragment!.includes(`id="${newest.id}"`), "newest public entry listed");
  assert.ok(fragment!.includes(esc(newest.title.en!)), "with its English title");
  for (const hidden of entries.filter((e) => e.audience !== "public")) {
    assert.ok(!fragment!.includes(`id="${hidden.id}"`), `${hidden.id} stays out of crawler HTML`);
  }
});

test("each real public entry answers at its own address; an internal one and an unknown one are 404", { skip: NO_FOLDER }, async () => {
  const { entries } = loadChangelog();
  const newest = entries.find((e) => e.audience === "public")!;
  const meta = await getMetaForPath(`/updates/${newest.id}`);
  assert.equal(meta.status, undefined);
  assert.equal(meta.title, newest.title.en);
  assert.equal(meta.url, `${PUBLIC_ORIGIN}/updates/${newest.id}`);
  const fragment = await renderPublicContent(`/updates/${newest.id}`);
  assert.ok(fragment!.includes(esc(newest.title.en!)));
  const zh = await getMetaForPath(`/updates/${newest.id}/zh`);
  assert.equal(zh.lang, "zh");
  assert.equal(zh.title, newest.title.zh);
  for (const hidden of entries.filter((e) => e.audience !== "public").slice(0, 3)) {
    assert.equal((await getMetaForPath(`/updates/${hidden.id}`)).status, 404, hidden.id);
    assert.equal(await renderPublicContent(`/updates/${hidden.id}`), null, hidden.id);
  }
  assert.equal((await getMetaForPath("/updates/2020-01-01-nothing")).status, 404);
  assert.equal((await getMetaForPath(`/updates/${newest.id}/en`)).status, 404);
});
