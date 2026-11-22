/**
 * The public pages against a real (in-memory) database: what the tag page,
 * the world page, the community pages and their sitemaps read, and what they
 * must never read.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, ensureTables } from "../db/index.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { clearPrerenderCache, forgetThreadPages, renderPublicContent } from "./prerender.js";
import { clearPublicPageCache, loadCommunitySitemapRows, loadTagCatalog, loadTagPage, loadThreadPage } from "./public-pages.js";
import { generateSitemaps, getMetaForPath } from "./seo.js";

const prefix = `pubpg${crypto.randomUUID().slice(0, 6)}`;
const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const creator = `${prefix}-creator`;
const other = `${prefix}-other`;
const staff = `${prefix}-staff`;
const banned = `${prefix}-banned`;
const fresh = `${prefix}-fresh`;
const muted = `${prefix}-muted`;
const forum = `${prefix}-forum`;
const uuid = () => crypto.randomUUID();
const threadIds = { long: uuid(), short: uuid(), replied: uuid(), selfReplied: uuid(), official: uuid(), pinned: uuid(), staff: uuid(), fresh: uuid(), muted: uuid(), adult: uuid(), banned: uuid() };
const eventIds = { live: uuid(), draft: uuid() };
const longBody = `Start with three variables. ${"Then add a rule for each one and watch them interact. ".repeat(6)}`;

const schema = JSON.stringify({
  entries: [
    { id: "e0", role: "character", content: "SECRET CHARACTER SHEET" },
    { id: "e1", role: "greeting", enabled: false, content: "A disabled opening." },
    { id: "e2", role: "greeting", content: "<style>p{}</style>*The bell rings* over the schoolyard, {{user}}.\n\n[trust: add 1] You are late again." },
    { id: "e3", role: "greeting", content: "A second opening." },
  ],
});

before(async () => {
  await ensureTables();
  // Accounts are a month old, except the one that signed up today.
  for (const [id, name, role, isBanned, ageDays] of [
    [creator, "Mia", "user", false, 30], [other, "Ren", "user", false, 30], [staff, "Staff", "admin", false, 30],
    [banned, "Gone", "user", true, 30], [fresh, "Newcomer", "user", false, 0], [muted, "Quiet", "user", false, 30],
  ] as const) {
    await db.execute(sql`INSERT INTO "user"(id, name, email, username, email_verified, role, is_banned, created_at, updated_at)
      VALUES (${id}, ${name}, ${`${id}@example.test`}, ${id}, true, ${role}, ${isBanned}, now() - make_interval(days => ${ageDays}), now())`);
  }
  await db.execute(sql`INSERT INTO user_mutes(user_id, reason, expires_at) VALUES (${muted}, 'test', now() + interval '3 days')`);
  const world = (key: string, by: string, name: string, tags: string[], extra: { age?: string; visibility?: string; schema?: string; description?: string; downloads?: number } = {}) =>
    db.execute(sql`INSERT INTO worlds(id, public_id, creator_id, name, description, status, is_published, visibility, age_rating, language, schema, tags, download_count)
      VALUES (${`${prefix}-${key}`}, ${`${hex}${key}`}, ${by}, ${name}, ${extra.description ?? "A campus love story."}, 'published', true, ${extra.visibility ?? "public"}, ${extra.age ?? "all"}, 'en',
        ${extra.schema ?? "{}"}::jsonb, ${JSON.stringify(tags)}::jsonb, ${extra.downloads ?? 10})`);
  await world("a1", creator, "Sakura Season", ["恋爱", "校园"], { schema, description: "", downloads: 900 });
  await world("a2", creator, "Plum Rain", ["Romance", "Fantasy"]);
  await world("a3", other, "Station Clock", ["romance", "校园", "NSFW"], { downloads: 500 });
  await world("a4", other, "Night Bus", ["恋爱"]);
  await world("a5", other, "Paper Cranes", ["恋爱", "School"]);
  await world("b1", other, "ADULT WORLD", ["恋爱", "校园"], { age: "r18", downloads: 99999 });
  await world("b2", other, "PRIVATE WORLD", ["恋爱", "校园"], { visibility: "private", downloads: 99999 });

  await db.execute(sql`INSERT INTO forums(id, name, slug, description, sort_order) VALUES (${forum}, 'Guides', ${forum}, 'How-tos.', 0)`);
  const thread = (id: string, by: string, title: string, content: string, extra: { age?: string; official?: boolean; pinned?: boolean; replies?: number } = {}) =>
    db.execute(sql`INSERT INTO threads(id, forum_id, author_id, title, content, age_rating, is_official, is_pinned, reply_count)
      VALUES (${id}, ${forum}, ${by}, ${title}, ${content}, ${extra.age ?? "all"}, ${extra.official ?? false}, ${extra.pinned ?? false}, ${extra.replies ?? 0})`);
  await thread(threadIds.long, creator, "How I built a stat-driven RPG", longBody, { replies: 3 });
  await thread(threadIds.short, creator, "hi", "hello");
  await thread(threadIds.replied, creator, "Which model for long stories?", "Looking for one that keeps plot threads over 200 turns.", { replies: 1 });
  await thread(threadIds.selfReplied, creator, "bump", "anyone?", { replies: 1 });
  await thread(threadIds.fresh, fresh, "FRESH ACCOUNT THREAD", longBody, { replies: 1 });
  await thread(threadIds.muted, muted, "MUTED AUTHOR THREAD", longBody, { replies: 1 });
  await thread(threadIds.official, creator, "Rules", "Be kind.", { official: true });
  await thread(threadIds.pinned, creator, "Start here", "Read this.", { pinned: true });
  await thread(threadIds.staff, staff, "Maintenance", "Tonight.");
  await thread(threadIds.adult, creator, "ADULT THREAD", `ADULT BODY ${longBody}`, { age: "r18", replies: 5 });
  await thread(threadIds.banned, banned, "BANNED THREAD", `BANNED BODY ${longBody}`, { replies: 5 });
  const post = (by: string, floor: number, content: string, threadId = threadIds.long) =>
    db.execute(sql`INSERT INTO posts(id, thread_id, author_id, content, floor) VALUES (${uuid()}, ${threadId}, ${by}, ${content}, ${floor})`);
  await post(other, 1, "Thanks, this **helped**.");
  await post(banned, 2, "BANNED REPLY");
  await post(staff, 3, "Pinned to the guides.");
  await post(other, 1, "ADULT REPLY", threadIds.adult);
  await post(other, 1, "Try the long-context one.", threadIds.replied);
  await post(creator, 1, "bump again", threadIds.selfReplied);
  await post(other, 1, "Welcome!", threadIds.fresh);
  await post(other, 1, "Noted.", threadIds.muted);
  // The long thread shares two worlds; only the public all-ages one may be linked.
  await db.execute(sql`INSERT INTO thread_worlds(thread_id, world_id, sort_order) VALUES (${threadIds.long}, ${`${prefix}-b1`}, 0), (${threadIds.long}, ${`${prefix}-a1`}, 1)`);
  // 45 more replies on the long thread: 47 shown in all, three pages of 20.
  for (let floor = 4; floor <= 48; floor++) await post(other, floor, `Reply number ${floor}.`);

  const event = (id: string, title: string, status: string) =>
    db.execute(sql`INSERT INTO community_events(id, title, introduction, status, lang) VALUES (${id}, ${title}, 'Build a world in two weeks.', ${status}, 'en')`);
  await event(eventIds.live, "Autumn Jam", "live");
  await event(eventIds.draft, "DRAFT EVENT", "draft");
  clearPublicPageCache();
  clearPrerenderCache();
});

after(async () => {
  await db.execute(sql`DELETE FROM user_mutes WHERE user_id = ${muted}`);
  await db.execute(sql`DELETE FROM community_events WHERE id IN (${eventIds.live}, ${eventIds.draft})`);
  await db.execute(sql`DELETE FROM forums WHERE id = ${forum}`);
  await db.execute(sql`DELETE FROM worlds WHERE id LIKE ${`${prefix}-%`}`);
  await db.execute(sql`DELETE FROM "user" WHERE id LIKE ${`${prefix}-%`}`);
});

test("a tag counts and lists only public all-ages worlds, whatever spelling they store", async () => {
  const catalog = await loadTagCatalog();
  assert.equal(catalog.get("romance")?.count, 5);
  assert.equal(catalog.get("school")?.count, 3);
  assert.equal(catalog.has("nsfw"), false);

  const page = await loadTagPage("romance");
  assert.ok(page);
  assert.deepEqual(page.worlds.map((w) => w.name).slice(0, 2), ["Sakura Season", "Station Clock"], "most played first");
  assert.equal(page.worlds.length, 5);
  assert.ok(!page.worlds.some((w) => /ADULT|PRIVATE/.test(w.name)));
  assert.deepEqual(page.related.map((t) => t.slug), ["school", "fantasy"]);

  const meta = await getMetaForPath("/app/tag/Romance/");
  assert.equal(meta.status, undefined);
  assert.equal(meta.url, `${PUBLIC_ORIGIN}/app/tag/romance`, "any casing points at the one address");
  const html = await renderPublicContent("/app/tag/romance");
  assert.match(html!, /<h1 class="pre-h1">Romance<\/h1><p class="pre-lede">5 worlds<\/p>/);
  assert.match(html!, new RegExp(`<a href="/@${creator}/sakura-season-${hex}a1">Sakura Season</a>`));
  assert.doesNotMatch(html!, /ADULT|PRIVATE/);

  assert.equal((await getMetaForPath("/app/tag/fantasy")).status, undefined, "one world is enough for the page to exist");
  assert.equal((await getMetaForPath("/app/tag/horror")).status, 404, "no world, no page");
});

test("the world page reads the first enabled opening and nothing else from the schema", async () => {
  const path = `/@${creator}/sakura-season-${hex}a1`;
  const html = await renderPublicContent(path);
  assert.match(html!, /<h2 class="pre-h2">Opening<\/h2><div class="pre-text"><p>The bell rings over the schoolyard, you\.<\/p><p>You are late again\.<\/p><\/div>/);
  assert.doesNotMatch(html!, /SECRET|disabled opening|second opening|trust|<style>/i);
  // More like this: other creators' worlds sharing tags, the closest first; never the hidden ones.
  const similar = /pre-similar.*$/.exec(html!)![0];
  assert.match(similar, /Station Clock.*Paper Cranes/s);
  assert.doesNotMatch(similar, /Plum Rain|ADULT|PRIVATE/);
  // This world has no description, so the opening is what a search result shows.
  const meta = await getMetaForPath(path);
  assert.equal(meta.description, "The bell rings over the schoolyard, you. You are late again.");
});

test("an adult world's page still gets no content and no extras", async () => {
  const path = `/@${other}/adult-world-${hex}b1`;
  assert.equal(await renderPublicContent(path), null);
  const meta = await getMetaForPath(path);
  assert.equal(meta.noindex, true);
  assert.equal(meta.title, "Yumina");
});

test("a thread page shows the post and its first 20 replies from accounts in good standing; later pages follow", async () => {
  const path = `/app/community/thread/${threadIds.long}`;
  const page = await loadThreadPage(threadIds.long);
  assert.equal(page!.replies.length, 20);
  assert.deepEqual(page!.replies.slice(0, 3).map((r) => r.floor), [1, 3, 4], "the banned member's reply is not shown");
  assert.deepEqual([page!.page, page!.pageCount, page!.replyTotal], [1, 3, 47]);
  const html = await renderPublicContent(path);
  assert.match(html!, /<h1 class="pre-h1">How I built a stat-driven RPG<\/h1>/);
  assert.match(html!, /Start with three variables\./);
  assert.match(html!, /Thanks, this helped\./);
  assert.match(html!, /<span class="pre-staff">Staff<\/span>/);
  assert.match(html!, new RegExp(`Page 1 of 3 · <a rel="next" href="${path}\\?page=2">Next page</a>`));
  assert.doesNotMatch(html!, /BANNED|Reply number 22\./);
  // The world the post shares is a link to its page; the adult one it also shares is not there at all.
  assert.match(html!, new RegExp(`<h2 class="pre-h2">World in this post</h2><div class="pre-grid"><a class="pre-card" href="/@${creator}/sakura-season-${hex}a1">`));
  assert.doesNotMatch(html!, /ADULT WORLD/);
  const meta = await getMetaForPath(path);
  assert.equal(meta.noindex, undefined);
  assert.equal(meta.title, "How I built a stat-driven RPG - Guides - Yumina Community");
  const posting = (meta.jsonLd as { "@graph": Array<Record<string, any>> })["@graph"][0]!;
  assert.equal(posting["@type"], "DiscussionForumPosting");
  assert.equal(posting.commentCount, 47);
  assert.equal(posting.comment.length, 20);

  // Page 2 has the next twenty; a sort or tracking parameter is the same page.
  const second = await renderPublicContent(path, { page: "2" });
  assert.match(second!, /Reply number 22\./);
  assert.doesNotMatch(second!, /Start with three variables|Thanks, this helped/);
  assert.match(second!, new RegExp(`<a rel="prev" href="${path}">Previous page</a> · Page 2 of 3 · <a rel="next" href="${path}\\?page=3">`));
  const secondMeta = await getMetaForPath(path, { page: "2" });
  assert.equal(secondMeta.url, `${PUBLIC_ORIGIN}${path}?page=2`);
  assert.match(secondMeta.title, / - Page 2 - Guides - Yumina Community$/);
  assert.equal((await getMetaForPath(path, { page: "abc" })).url, `${PUBLIC_ORIGIN}${path}`);
  // A page past the end is not a page.
  assert.equal((await getMetaForPath(path, { page: "9" })).status, 404);
  assert.equal(await renderPublicContent(path, { page: "9" }), null);
});

test("public threads that do not pass the rule keep their own title and carry noindex", async () => {
  for (const key of ["short", "selfReplied", "fresh", "muted"] as const) {
    const meta = await getMetaForPath(`/app/community/thread/${threadIds[key]}`);
    assert.equal(meta.noindex, true, key);
    assert.equal(meta.follow, true, key);
    assert.equal(meta.status, undefined, key);
    assert.match(meta.title, / - Guides - Yumina Community$/, key);
    assert.equal(meta.jsonLd, undefined, key);
  }
  for (const key of ["replied", "official", "pinned", "staff"] as const) {
    const meta = await getMetaForPath(`/app/community/thread/${threadIds[key]}`);
    assert.equal(meta.noindex, undefined, key);
    assert.ok(meta.jsonLd, key);
  }
});

test("an adult thread and a banned author's thread are never rendered and never indexed", async () => {
  for (const id of [threadIds.adult, threadIds.banned]) {
    const path = `/app/community/thread/${id}`;
    assert.equal(await renderPublicContent(path), null);
    const meta = await getMetaForPath(path);
    assert.equal(meta.noindex, true);
    assert.equal(meta.title, "Yumina");
    assert.equal(meta.status, undefined, "the thread exists; the app shows its own wall");
    const page = await loadThreadPage(id);
    assert.equal(page!.thread.content, "", "the cached row does not even hold the text");
    assert.deepEqual(page!.replies, []);
  }
});

test("the community, a board and an event list what a visitor can open", async () => {
  const community = await renderPublicContent("/app/community");
  assert.match(community!, new RegExp(`<a href="/app/community/${forum}">Guides</a>`));
  assert.match(community!, new RegExp(`<a href="/app/community/thread/${threadIds.long}">How I built a stat-driven RPG</a>`));
  assert.match(community!, new RegExp(`<a href="/app/community/events/${eventIds.live}">Autumn Jam</a>`));
  assert.doesNotMatch(community!, /ADULT|BANNED|DRAFT/);

  const board = await renderPublicContent(`/app/community/${forum}`);
  assert.match(board!, /<h1 class="pre-h1">Guides<\/h1><p class="pre-lede">How-tos\.<\/p>/);
  assert.match(board!, /Start here/);
  assert.doesNotMatch(board!, /ADULT|BANNED/);
  assert.equal((await getMetaForPath(`/app/community/${forum}`)).title, "Guides");

  assert.match((await renderPublicContent(`/app/community/events/${eventIds.live}`))!, /<h1 class="pre-h1">Autumn Jam<\/h1>/);
  assert.equal(await renderPublicContent(`/app/community/events/${eventIds.draft}`), null);
  assert.equal((await getMetaForPath(`/app/community/events/${eventIds.draft}`)).status, 404);
});

test("a deleted thread is a 404 at once, and a re-rated one leaves search at once, on the instance that handled it", async () => {
  const id = threadIds.replied;
  const path = `/app/community/thread/${id}`;
  assert.equal((await getMetaForPath(path)).noindex, undefined);
  assert.ok(await renderPublicContent(path));

  // An admin re-rates it: the page is cached, so without the refresh it would stay indexable for a minute.
  await db.execute(sql`UPDATE threads SET age_rating = 'r18' WHERE id = ${id}`);
  assert.equal((await getMetaForPath(path)).noindex, undefined, "still cached");
  forgetThreadPages(id);
  const rerated = await getMetaForPath(path);
  assert.equal(rerated.noindex, true);
  assert.equal(rerated.title, "Yumina");
  assert.equal(await renderPublicContent(path), null);

  // Back to all-ages: indexable again by itself.
  await db.execute(sql`UPDATE threads SET age_rating = 'all' WHERE id = ${id}`);
  forgetThreadPages(id);
  assert.equal((await getMetaForPath(path)).noindex, undefined);

  // Moved to another board: the title and breadcrumb follow.
  await db.execute(sql`INSERT INTO forums(id, name, slug, description, sort_order) VALUES (${`${forum}-2`}, 'Help', ${`${forum}-2`}, '', 1)`);
  await db.execute(sql`UPDATE threads SET forum_id = ${`${forum}-2`} WHERE id = ${id}`);
  forgetThreadPages(id);
  assert.match((await getMetaForPath(path)).title, / - Help - Yumina Community$/);

  // Deleted: gone.
  await db.execute(sql`DELETE FROM threads WHERE id = ${id}`);
  forgetThreadPages(id);
  assert.equal((await getMetaForPath(path)).status, 404);
  assert.equal(await renderPublicContent(path), null);
  await db.execute(sql`DELETE FROM forums WHERE id = ${`${forum}-2`}`);
});

test("the community sitemap lists threads that pass the bar and nothing a visitor cannot read", async () => {
  const rows = await loadCommunitySitemapRows();
  const ids = new Set(rows.threads.map((t) => t.id));
  for (const key of ["long", "official", "pinned", "staff"] as const) assert.ok(ids.has(threadIds[key]), key);
  for (const key of ["short", "selfReplied", "fresh", "muted", "adult", "banned"] as const) assert.ok(!ids.has(threadIds[key]), key);
  assert.ok(rows.events.some((e) => e.id === eventIds.live));
  assert.ok(!rows.events.some((e) => e.id === eventIds.draft));

  const files = await generateSitemaps();
  const community = files.children.get("sitemap-community.xml")!;
  assert.ok(files.index.includes(`<loc>${PUBLIC_ORIGIN}/sitemap-community.xml</loc>`));
  assert.ok(community.includes(`<loc>${PUBLIC_ORIGIN}/app/community/thread/${threadIds.long}</loc>`));
  assert.ok(community.includes(`<loc>${PUBLIC_ORIGIN}/app/community/${forum}</loc>`));
  for (const key of ["short", "selfReplied", "fresh", "muted", "adult", "banned"] as const) assert.ok(!community.includes(threadIds[key]), key);
  assert.doesNotMatch(community, /\?page=|#reply/, "only a thread's own address is listed");
  assert.match(community, new RegExp(`<loc>${PUBLIC_ORIGIN}/app/community/${forum}</loc>\n    <lastmod>\\d{4}-\\d\\d-\\d\\d</lastmod>`), "a board is dated by its newest thread activity");
  const pages = files.children.get("sitemap-pages.xml")!;
  assert.ok(pages.includes(`<loc>${PUBLIC_ORIGIN}/app/tag/romance</loc>`), "five worlds: listed");
  assert.ok(!pages.includes(`<loc>${PUBLIC_ORIGIN}/app/tag/school</loc>`), "three worlds: a page, not listed");
  assert.ok(pages.includes(`<loc>${PUBLIC_ORIGIN}/app/community</loc>`));
  assert.ok(!pages.includes(`<loc>${PUBLIC_ORIGIN}/app/worlds</loc>`), "the signed-in Create page is not in the sitemap");
});
