import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, ensureTables } from "../db/index.js";
import { generateSitemaps, getMetaForPath, injectMeta } from "./seo.js";
import { findLanguageSiblings } from "./world-address.js";

const template = readFileSync(new URL("../../../app/index.html", import.meta.url), "utf8");

const prefix = `seoworld${crypto.randomUUID().slice(0, 6)}`;
// public ids are hex, like the real ones
const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const creator = `${prefix}-creator`;
const group = `${prefix}-group`;
const en = { id: `${prefix}-en`, publicId: `${hex}aaaa`, name: "Sakura Season", language: "en" };
const zh = { id: `${prefix}-zh`, publicId: `${hex}bbbb`, name: "樱花季节", language: "zh" };
const game = { id: `${prefix}-game`, publicId: `${hex}cccc`, name: "Poison Battle Royale", language: "en" };

before(async () => {
  await ensureTables();
  await db.execute(sql`INSERT INTO "user"(id, name, email, username, email_verified, created_at, updated_at)
    VALUES (${creator}, 'Mia', ${`${creator}@example.test`}, ${prefix}, true, now(), now()) ON CONFLICT DO NOTHING`);
  for (const w of [en, zh]) {
    await db.execute(sql`INSERT INTO worlds(id, public_id, creator_id, name, description, status, is_published, visibility, age_rating, language, language_group_id, tags, download_count, review_count, average_rating)
      VALUES (${w.id}, ${w.publicId}, ${creator}, ${w.name}, 'A campus love story.', 'published', true, 'public', 'all', ${w.language}, ${group}, '["恋爱","Anime"]'::jsonb, 38500, 5, 4.42)`);
  }
  // game_path is derived by a trigger from the world's schema, so set it there.
  await db.execute(sql`INSERT INTO worlds(id, public_id, creator_id, name, description, status, is_published, visibility, age_rating, language, schema, tags, download_count, review_count, average_rating)
    VALUES (${game.id}, ${game.publicId}, ${creator}, ${game.name}, 'Last one standing.', 'published', true, 'public', 'all', 'en', '{"game":{"path":"/games/poison"}}'::jsonb, '["游戏"]'::jsonb, 999, 1, 5)`);
});

after(async () => {
  await db.execute(sql`DELETE FROM worlds WHERE id LIKE ${`${prefix}-%`}`);
  await db.execute(sql`DELETE FROM "user" WHERE id = ${creator}`);
});

test("a world in two languages lists both as alternates, with English as the default", async () => {
  const siblings = await findLanguageSiblings({ id: en.id, languageGroupId: group });
  assert.deepEqual(siblings.map((s) => s.language), ["zh"]);

  const meta = await getMetaForPath(`/@${prefix}/sakura-season-${en.publicId}`);
  assert.equal(meta.title, "Sakura Season");
  assert.ok(meta.alternates, "alternates present");
  assert.deepEqual(meta.alternates!.map((a) => a.lang).sort(), ["en", "zh"]);
  const html = injectMeta(template, meta);
  assert.match(html, /<link rel="alternate" hreflang="zh" href="[^"]+\/@seoworld[a-z0-9]+\/[^"]*bbbb" \/>/);
  assert.match(html, /<link rel="alternate" hreflang="en" href="[^"]+aaaa" \/>/);
  assert.match(html, /<link rel="alternate" hreflang="x-default" href="[^"]+aaaa" \/>/);

  const zhMeta = await getMetaForPath(`/@${prefix}/x-${zh.publicId}`);
  assert.deepEqual(zhMeta.alternates!.map((a) => a.lang).sort(), ["en", "zh"]);
});

test("a story world carries genre, plays and a real rating; a game world is a VideoGame that costs nothing", async () => {
  const story = (await getMetaForPath(`/@${prefix}/sakura-season-${en.publicId}`)).jsonLd as Record<string, unknown>;
  assert.equal(story["@type"], "CreativeWork");
  assert.deepEqual(story.genre, ["恋爱", "Anime"]);
  assert.deepEqual(story.interactionStatistic, { "@type": "InteractionCounter", interactionType: "https://schema.org/PlayAction", userInteractionCount: 38500 });
  assert.deepEqual(story.aggregateRating, { "@type": "AggregateRating", ratingValue: 4.4, bestRating: 5, worstRating: 1, ratingCount: 5 });
  assert.equal((story.author as { url?: string }).url, `https://yumina.io/@${prefix}`.replace("https://yumina.io", (story.isPartOf as { url: string }).url));

  const g = (await getMetaForPath(`/@${prefix}/poison-${game.publicId}`)).jsonLd as Record<string, unknown>;
  assert.deepEqual(g["@type"], ["VideoGame", "SoftwareApplication"]);
  assert.equal((g.offers as { price: number }).price, 0);
  assert.equal(g.aggregateRating, undefined, "one review is not a rating");
});

test("the worlds sitemap declares the languages of a world on each of its entries", async () => {
  const { index, children } = await generateSitemaps();
  assert.match(index, /<loc>[^<]+\/sitemap-worlds\.xml<\/loc>/, "the index lists the worlds child");
  const xml = children.get("sitemap-worlds.xml")!;
  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.doesNotMatch(xml, /<loc>[^<]+\/blog<\/loc>/, "site pages live in the pages child");
  assert.match(children.get("sitemap-pages.xml")!, new RegExp(`<loc>[^<]+/@${prefix}</loc>`), "the creator's page is a site page");
  const entry = xml.split("<url>").find((u) => u.includes(`-${en.publicId}</loc>`));
  assert.ok(entry, "english world listed");
  assert.match(entry!, /<xhtml:link rel="alternate" hreflang="zh" href="[^"]+bbbb" \/>/);
  assert.match(entry!, /<xhtml:link rel="alternate" hreflang="en" href="[^"]+aaaa" \/>/);
  const gameEntry = xml.split("<url>").find((u) => u.includes(`-${game.publicId}</loc>`));
  assert.ok(gameEntry && !gameEntry.includes("xhtml:link"), "a world with one language has no alternates");
});
