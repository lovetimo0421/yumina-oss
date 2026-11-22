/**
 * The genre pages (/ai-rpg and the rest): the words on each page, the
 * structured data that mirrors them, and, against a real (in-memory)
 * database, which worlds a page lists.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { findTagEntry } from "@yumina/shared";
import { db, ensureTables } from "../db/index.js";
import { edition } from "../edition/index.js";
import { listBlogPosts } from "./blog.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { LANDING_PAGES, findLandingPage, landingLinks, landingMeta, landingPaths, renderLanding, type LandingContent } from "./landing-public.js";
import { clearPrerenderCache, renderHome, renderPublicContent } from "./prerender.js";
import { clearPublicPageCache, loadLandingData, pageTagEntry } from "./public-pages.js";
import { isPublicIntroPath } from "../routes/public-page.js";
import { generateSitemaps, getMetaForPath, invalidateSitemaps, landingSitemapUrls } from "./seo.js";

const NO_HUB = edition.info().features.hub ? false : "this edition has no Discover";
const NO_BLOG = listBlogPosts().length ? false : "this edition ships no blog posts";

const content: LandingContent = {
  worlds: [
    { id: "w1", publicId: "abc123", name: "Iron <Keep>", creatorName: "Mia", creatorUsername: "mia", description: "Hold the keep through one winter. Food, walls and morale are tracked." },
    { id: "w2", publicId: null, name: "Dice & Dust", creatorName: null, creatorUsername: null, description: null },
  ],
  tags: [{ slug: "rpg", label: "RPG" }, { slug: "dungeon", label: "Dungeon" }],
};

const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const graphOf = (page: (typeof LANDING_PAGES)[number], data = content) =>
  (landingMeta(page, data).jsonLd as { "@graph": Array<Record<string, any>> })["@graph"];

test("the nine pages exist at their addresses and nothing else does", () => {
  assert.deepEqual(landingPaths(), ["/ai-rpg", "/ai-roleplay", "/ai-text-adventure", "/ai-games", "/ai-chat", "/multiplayer-ai-games", "/ai-visual-novel", "/ai-story-games", "/ai-dungeon-master"]);
  for (const path of landingPaths()) assert.ok(findLandingPage(path), path);
  for (const path of ["/ai-nonsense", "/ai-rpg/extra", "/ai", "/", "/pricing", "ai-rpg"]) assert.equal(findLandingPage(path), undefined, path);
  assert.equal(isPublicIntroPath("/ai-rpg"), true);
  assert.equal(isPublicIntroPath("/ai-nonsense"), false);
});

test("each page renders its headline, intro, list, steps, questions and links, in that order", () => {
  for (const page of LANDING_PAGES) {
    const html = renderLanding(page, content);
    assert.ok(html.startsWith(`<main class="pre pre-landing">`), page.slug);
    assert.ok(html.includes(`<h1 class="pre-h1">${page.h1}</h1>`), `${page.slug} h1`);
    assert.ok(page.h1.toLowerCase().includes(page.phrase.toLowerCase().replace(/s$/, "")), `${page.slug}: the headline carries the phrase`);
    for (const paragraph of page.intro) assert.ok(decode(html).includes(`<p>${paragraph}</p>`), `${page.slug} intro`);
    assert.match(page.intro.join(" "), /free/i, `${page.slug}: says playing is free`);

    // The list: name linked to the world's address, creator, description; every value escaped.
    assert.ok(html.includes(`<a href="/@mia/iron-keep-abc123">Iron &lt;Keep&gt;</a> <span class="pre-card__by"><a href="/@mia">Mia</a></span><p>Hold the keep through one winter.`), page.slug);
    assert.ok(html.includes(`<li><a href="/app/hub/w2">Dice &amp; Dust</a></li>`), page.slug);

    assert.ok(page.steps.length >= 3 && page.steps.length <= 4, `${page.slug}: three or four steps`);
    for (const step of page.steps) assert.ok(decode(html).includes(`<li>${step}</li>`), `${page.slug} step`);
    assert.ok(page.faq.length >= 5 && page.faq.length <= 7, `${page.slug}: five to seven questions`);

    // The other pages, the tag pages, never itself.
    for (const other of LANDING_PAGES) {
      assert.equal(html.includes(`<li><a href="/${other.slug}">`), other !== page, `${page.slug} -> ${other.slug}`);
    }
    assert.ok(html.includes(`<li><a href="/app/tag/rpg">RPG</a></li><li><a href="/app/tag/dungeon">Dungeon</a></li>`), page.slug);

    const order = [`<h1`, page.listHeading, "How it works", "Questions", "More to play", "Browse by tag"].map((mark) => html.indexOf(mark));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)), `${page.slug}: order ${order.join(",")}`);
    assert.doesNotMatch(html, /—|–/, `${page.slug}: no dashes`);
  }
});

test("the questions in the structured data are the visible ones, word for word", () => {
  for (const page of LANDING_PAGES) {
    const html = renderLanding(page, content);
    const visible = [...html.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map((m) => ({ q: decode(m[1]!), a: decode(m[2]!) }));
    const faq = graphOf(page).find((n) => n["@type"] === "FAQPage")!;
    const data = faq.mainEntity.map((item: any) => ({ q: item.name, a: item.acceptedAnswer.text }));
    assert.deepEqual(data, visible, page.slug);
    assert.deepEqual(visible, page.faq, page.slug);
    assert.equal(new Set(visible.map((f) => f.q)).size, visible.length, `${page.slug}: no question twice`);
    for (const f of visible) {
      const sentences = f.a.split(/(?<=[.?!])\s+/).length;
      assert.ok(sentences >= 1 && sentences <= 3, `${page.slug}: "${f.q}" has ${sentences} sentences`);
    }
  }
});

test("the meta carries the collection, the list of worlds and the breadcrumb", () => {
  for (const page of LANDING_PAGES) {
    const meta = landingMeta(page, content);
    assert.equal(meta.url, `${PUBLIC_ORIGIN}/${page.slug}`);
    assert.ok(meta.title.toLowerCase().startsWith(page.phrase.toLowerCase()), `${meta.title}: the phrase comes first`);
    assert.ok(meta.title.length <= 65, `${meta.title} is ${meta.title.length} characters`);
    assert.ok(meta.description.length >= 110 && meta.description.length <= 160, `${page.slug} description is ${meta.description.length} characters`);
    const graph = graphOf(page);
    const collection = graph.find((n) => n["@type"] === "CollectionPage")!;
    assert.equal(collection.mainEntity["@type"], "ItemList");
    assert.deepEqual(collection.mainEntity.itemListElement.map((i: any) => [i.position, i.name, i.url]), [
      [1, "Iron <Keep>", `${PUBLIC_ORIGIN}/@mia/iron-keep-abc123`],
      [2, "Dice & Dust", `${PUBLIC_ORIGIN}/app/hub/w2`],
    ]);
    const crumbs = graph.find((n) => n["@type"] === "BreadcrumbList")!;
    assert.deepEqual(crumbs.itemListElement.map((i: any) => i.item), [PUBLIC_ORIGIN, `${PUBLIC_ORIGIN}/${page.slug}`]);
    // No worlds yet: the page still reads, without a list block or an empty ItemList.
    const empty = { worlds: [], tags: [] };
    assert.equal(graphOf(page, empty).find((n) => n["@type"] === "CollectionPage")!.mainEntity, undefined);
    assert.ok(!renderLanding(page, empty).includes(page.listHeading));
  }
});

test("every tag a page maps to is a vocabulary tag that may have a page", () => {
  for (const page of LANDING_PAGES) {
    assert.ok(page.tags.length > 0, page.slug);
    for (const tag of page.tags) {
      assert.equal(findTagEntry(tag)?.canonical, tag, `${page.slug}: "${tag}" is not a canonical vocabulary tag`);
      assert.ok(pageTagEntry(tag), `${page.slug}: "${tag}" gets no page`);
    }
  }
});

test("each page links two or three blog posts that exist", { skip: NO_BLOG }, () => {
  const slugs = new Set(listBlogPosts().map((p) => p.slug));
  for (const page of LANDING_PAGES) {
    assert.ok(page.blog.length >= 2 && page.blog.length <= 3, page.slug);
    const html = renderLanding(page, content);
    for (const slug of page.blog) {
      assert.ok(slugs.has(slug), `${page.slug}: no post "${slug}"`);
      assert.ok(html.includes(`<li><a href="/blog/${slug}">`), `${page.slug} -> /blog/${slug}`);
    }
  }
});

test("the home page gets a Browse block with the nine pages, and none without them", () => {
  const card = { id: "w1", publicId: "abc123", name: "Iron Keep", thumbnailUrl: null, creatorName: "Mia", creatorUsername: "mia" };
  const html = renderHome([card], { tags: [], posts: [], fresh: [], browse: landingLinks(), pricing: false, atelier: false, community: false });
  assert.ok(html.includes(
    `<section class="pre-more"><h2 class="pre-h2">Browse</h2><ul class="pre-tags"><li><a href="/ai-rpg">AI RPG</a></li><li><a href="/ai-roleplay">AI roleplay</a></li>` +
    `<li><a href="/ai-text-adventure">AI text adventure</a></li><li><a href="/ai-games">AI games</a></li>` +
    `<li><a href="/ai-chat">AI chat</a></li><li><a href="/multiplayer-ai-games">Multiplayer AI games</a></li><li><a href="/ai-visual-novel">AI visual novel</a></li>` +
    `<li><a href="/ai-story-games">AI story games</a></li><li><a href="/ai-dungeon-master">AI dungeon master</a></li></ul></section>`,
  ));
  assert.doesNotMatch(renderHome([card]), /Browse/);
});

test("the sitemap entries are the nine addresses", () => {
  assert.deepEqual(
    landingSitemapUrls().map((u) => /<loc>(.*?)<\/loc>/.exec(u.xml)![1]),
    ["/ai-rpg", "/ai-roleplay", "/ai-text-adventure", "/ai-games", "/ai-chat", "/multiplayer-ai-games", "/ai-visual-novel", "/ai-story-games", "/ai-dungeon-master"].map((p) => `${PUBLIC_ORIGIN}${p}`),
  );
  for (const entry of landingSitemapUrls()) assert.match(entry.xml, /<changefreq>daily<\/changefreq>\n {4}<priority>0\.8<\/priority>/);
});

// ── against the database ─────────────────────────────────────────────────────

const prefix = `land${crypto.randomUUID().slice(0, 6)}`;
const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const creator = `${prefix}-creator`;

before(async () => {
  await ensureTables();
  await db.execute(sql`INSERT INTO "user"(id, name, email, username, email_verified, role, created_at, updated_at)
    VALUES (${creator}, 'Mia', ${`${creator}@example.test`}, ${creator}, true, 'user', now() - interval '30 days', now())`);
  const world = (key: string, name: string, tags: string[], extra: { age?: string; visibility?: string; downloads?: number } = {}) =>
    db.execute(sql`INSERT INTO worlds(id, public_id, creator_id, name, description, status, is_published, visibility, age_rating, language, schema, tags, download_count)
      VALUES (${`${prefix}-${key}`}, ${`${hex}${key}`}, ${creator}, ${name}, 'A keep to hold through one winter.', 'published', true, ${extra.visibility ?? "public"}, ${extra.age ?? "all"}, 'en',
        '{}'::jsonb, ${JSON.stringify(tags)}::jsonb, ${extra.downloads ?? 10})`);
  await world("a1", "Iron Keep", ["RPG"], { downloads: 9_000_001 });
  await world("a2", "Cellar Dice", ["dnd", "恋爱"], { downloads: 9_000_000 });
  await world("a3", "Paper Cranes", ["恋爱"], { downloads: 9_000_005 });
  await world("b1", "ADULT WORLD", ["RPG"], { age: "r18", downloads: 9_999_999 });
  await world("b2", "PRIVATE WORLD", ["RPG"], { visibility: "private", downloads: 9_999_999 });
  await world("b3", "DRAINED WORLD", ["等级吸取"], { downloads: 9_999_999 });
  clearPublicPageCache();
  clearPrerenderCache();
  invalidateSitemaps();
});

after(async () => {
  await db.execute(sql`DELETE FROM worlds WHERE id LIKE ${`${prefix}-%`}`);
  await db.execute(sql`DELETE FROM "user" WHERE id = ${creator}`);
});

test("a page lists public all-ages worlds carrying any of its tags, in any spelling, most played first", async () => {
  const rpg = findLandingPage("/ai-rpg")!;
  const data = await loadLandingData(rpg.slug, rpg.tags);
  const names = data.worlds.map((w) => w.name);
  assert.deepEqual(names.filter((n) => ["Iron Keep", "Cellar Dice"].includes(n)), ["Iron Keep", "Cellar Dice"]);
  assert.ok(!names.includes("Paper Cranes"), "a world with none of the tags is not listed");
  assert.ok(!names.some((n) => /ADULT|PRIVATE|DRAINED/.test(n)), "adult and private worlds stay out");
  assert.ok(data.worlds.length <= 48);
  assert.ok(data.tags.some((t) => t.slug === "rpg") && data.tags.some((t) => t.slug === "d-and-d"), "the tags with a page are linked");

  // A tag that gets no page adds nothing to a list, even on an all-ages world.
  assert.deepEqual(await loadLandingData(`${prefix}-none`, ["等级吸取", "NSFW", "not a tag"]), { worlds: [], tags: [] });
});

test("each address is an indexable page with its own canonical, content and sitemap entry", { skip: NO_HUB }, async () => {
  for (const page of LANDING_PAGES) {
    const path = `/${page.slug}`;
    const meta = await getMetaForPath(path);
    assert.equal(meta.status, undefined, path);
    assert.equal(meta.noindex, undefined, path);
    assert.equal(meta.title, page.title);
    assert.equal(meta.url, `${PUBLIC_ORIGIN}${path}`);
    assert.equal((await getMetaForPath(`/${page.slug.toUpperCase()}/`)).url, `${PUBLIC_ORIGIN}${path}`, "any casing points at the one address");
    const html = await renderPublicContent(path);
    assert.ok(html!.includes(`<h1 class="pre-h1">${page.h1}</h1>`), path);
    assert.doesNotMatch(html!, /ADULT|PRIVATE|DRAINED/);
  }
  const html = await renderPublicContent("/ai-rpg");
  assert.ok(html!.includes(`<a href="/@${creator}/iron-keep-${hex}a1">Iron Keep</a>`));
  const meta = await getMetaForPath("/ai-rpg");
  const collection = (meta.jsonLd as { "@graph": Array<Record<string, any>> })["@graph"].find((n) => n["@type"] === "CollectionPage")!;
  assert.ok(collection.mainEntity.itemListElement.some((i: any) => i.url === `${PUBLIC_ORIGIN}/@${creator}/iron-keep-${hex}a1`));

  for (const path of ["/ai-nonsense", "/ai-rpg/extra", "/ai-rpgs"]) {
    assert.equal((await getMetaForPath(path)).status, 404, path);
    assert.equal(await renderPublicContent(path), null, path);
  }

  assert.match((await renderPublicContent("/"))!, /<h2 class="pre-h2">Browse<\/h2>.*href="\/ai-games"/);
  const pages = (await generateSitemaps()).children.get("sitemap-pages.xml")!;
  for (const path of landingPaths()) assert.ok(pages.includes(`<loc>${PUBLIC_ORIGIN}${path}</loc>`), path);
});
