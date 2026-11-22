import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ensureTables } from "../db/index.js";
import { findTagBySlug, TAG_VOCABULARY, tagPagePath, tagSlug } from "@yumina/shared";
import { PUBLIC_ORIGIN } from "./env.js";
import { renderTag } from "./prerender.js";
import { foldTagCounts, pageTagEntry, relatedTags, TAG_SITEMAP_MIN_WORLDS, type TagPage } from "./public-pages.js";
import { buildTagMeta, getMetaForPath, injectMeta, tagSitemapUrls } from "./seo.js";

before(async () => {
  await ensureTables();
});

test("every vocabulary tag has its own address and the address leads back to it", () => {
  const seen = new Map<string, string>();
  for (const entry of TAG_VOCABULARY) {
    const slug = tagSlug(entry.canonical);
    assert.ok(slug, `${entry.canonical} has no slug`);
    assert.match(slug, /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u, slug);
    assert.equal(seen.get(slug), undefined, `${entry.canonical} and ${seen.get(slug)} share the slug ${slug}`);
    seen.set(slug, entry.canonical);
    assert.equal(findTagBySlug(slug)?.canonical, entry.canonical);
  }
  // Any spelling of a tag has the same address.
  assert.equal(tagSlug("恋爱"), "romance");
  assert.equal(tagSlug("Romance"), "romance");
  assert.equal(tagPagePath("戀愛"), "/app/tag/romance");
  assert.equal(tagSlug("a tag nobody defined"), null);
  assert.equal(findTagBySlug("ROMANCE")?.canonical, "恋爱");
  assert.equal(findTagBySlug("no-such-tag"), undefined);
});

test("stored spellings fold onto one tag; adult and unknown tags get no page", () => {
  const catalog = foldTagCounts([
    { tag: "恋爱", count: 181 },
    { tag: "Romance", count: 25 },
    { tag: "romance", count: 14 },
    { tag: "Fantasy", count: 9 },
    { tag: "NSFW", count: 40 },
    { tag: "色情", count: 3 },
    { tag: "a tag nobody defined", count: 99 },
  ]);
  assert.deepEqual([...catalog.keys()].sort(), ["fantasy", "romance"]);
  assert.deepEqual(catalog.get("romance"), { canonical: "恋爱", slug: "romance", label: "Romance", count: 220 });
  assert.equal(pageTagEntry("nsfw"), undefined);
  assert.equal(pageTagEntry("Romance")?.canonical, "恋爱");
});

const romance = { canonical: "恋爱", slug: "romance", label: "Romance", count: 220 };
const page: TagPage = {
  tag: romance,
  worlds: [
    { id: "w1", publicId: "5c9c88e8", name: "Sakura Season", thumbnailUrl: null, creatorName: "mia~", creatorUsername: "mia", description: "# Sakura Season\n\nA **spring** story in a small town." },
    { id: "w2", publicId: null, name: `<script>alert(1)</script>`, thumbnailUrl: null, creatorName: `"><b>`, creatorUsername: null, description: null },
  ],
  related: [{ canonical: "校园", slug: "school", label: "School", count: 30 }],
};

test("related tags are the ones the listed worlds share most, never the tag itself or one without a page", () => {
  const catalog = foldTagCounts([
    { tag: "恋爱", count: 220 }, { tag: "校园", count: 30 }, { tag: "Fantasy", count: 9 }, { tag: "NSFW", count: 40 },
  ]);
  const related = relatedTags(romance, [["恋爱", "school", "NSFW"], ["Romance", "校园", "Fantasy"], ["romance", "School", "unknown"], null, "x"], catalog);
  assert.deepEqual(related.map((t) => t.slug), ["school", "fantasy"]);
});

test("the tag page lists worlds as links with creator and description, and links related tags", () => {
  const html = renderTag(page);
  assert.match(html, /^<main class="pre pre-tag"><h1 class="pre-h1">Romance<\/h1><p class="pre-lede">220 worlds<\/p>/);
  assert.match(html, /<li><a href="\/@mia\/sakura-season-5c9c88e8">Sakura Season<\/a> <span class="pre-card__by"><a href="\/@mia">mia~<\/a><\/span><p>A spring story in a small town\.<\/p><\/li>/);
  assert.match(html, /<h2 class="pre-h2">Related tags<\/h2><ul class="pre-tags"><li><a href="\/app\/tag\/school">School<\/a><\/li><\/ul>/);
  assert.doesNotMatch(html, /<script>|<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("tag meta names the tag, points at its own address and carries CollectionPage + ItemList", () => {
  const meta = buildTagMeta(page);
  assert.equal(meta.title, "Romance AI Games & Roleplay");
  assert.match(meta.description, /^220 Romance AI worlds to play free on Yumina/);
  assert.equal(meta.url, `${PUBLIC_ORIGIN}/app/tag/romance`);
  assert.equal(meta.noindex, undefined);
  const ld = meta.jsonLd as { "@type": string; mainEntity: { "@type": string; numberOfItems: number; itemListElement: Array<{ position: number; name: string; url: string }> } };
  assert.equal(ld["@type"], "CollectionPage");
  assert.equal(ld.mainEntity["@type"], "ItemList");
  assert.equal(ld.mainEntity.numberOfItems, 2);
  assert.deepEqual(ld.mainEntity.itemListElement[0], { "@type": "ListItem", position: 1, name: "Sakura Season", url: `${PUBLIC_ORIGIN}/@mia/sakura-season-5c9c88e8` });
  assert.equal(ld.mainEntity.itemListElement[1]!.url, `${PUBLIC_ORIGIN}/app/hub/w2`);
  // The script tag cannot be closed from inside a world's name.
  const html = injectMeta(`<html lang="en"><head><title>x</title></head></html>`, meta);
  assert.doesNotMatch(html, /<script>alert/);
});

test("an unknown tag, an adult tag and a tag no world carries are 404s", async () => {
  // The test database has no worlds, so even a real tag has no page here.
  for (const path of ["/app/tag/no-such-tag", "/app/tag/nsfw", "/app/tag/romance"]) {
    const meta = await getMetaForPath(path);
    assert.equal(meta.status, 404, path);
    assert.equal(meta.noindex, true, path);
  }
});

test(`the sitemap lists a tag once ${TAG_SITEMAP_MIN_WORLDS} public worlds carry it`, () => {
  assert.equal(TAG_SITEMAP_MIN_WORLDS, 5);
  const urls = tagSitemapUrls([
    { canonical: "a", slug: "small", label: "Small", count: 4 },
    { canonical: "b", slug: "enough", label: "Enough", count: 5 },
    romance,
  ]);
  const locs = urls.map((u) => /<loc>([^<]+)<\/loc>/.exec(u.xml)![1]);
  assert.deepEqual(locs, [`${PUBLIC_ORIGIN}/app/tag/romance`, `${PUBLIC_ORIGIN}/app/tag/enough`]);
});
