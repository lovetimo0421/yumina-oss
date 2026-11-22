import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ensureTables } from "../db/index.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { renderCommunity, renderEvent, renderForum, renderThread } from "./prerender.js";
import {
  cleanOpening,
  parsePageParam,
  THREAD_MIN_ACCOUNT_AGE_DAYS,
  THREAD_MIN_BODY_CHARS,
  THREAD_MIN_OTHER_REPLIES,
  THREAD_REPLIES_PER_PAGE,
  threadIndexable,
  type PublicThread,
  type ThreadPage,
  type ThreadSignals,
} from "./public-pages.js";
import { assembleSitemaps, buildThreadMeta, communitySitemapUrls, getMetaForPath, injectMeta, robotsValue, threadPageUrl, worldDescription } from "./seo.js";

before(async () => {
  await ensureTables();
});

const now = new Date("2026-11-15T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

const thread: PublicThread = {
  id: "0d9f6a54-1111-4222-8333-444455556666",
  title: "How I built a stat-driven RPG",
  content: "# How I built a stat-driven RPG\n\nStart with **three** variables.\n\n<img src=x onerror=alert(1)> Then add [rules](https://spam.example/x).",
  lang: "en",
  ageRating: "all",
  isPinned: false,
  isOfficial: false,
  replyCount: 2,
  likeCount: 7,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  updatedAt: new Date("2026-10-02T10:00:00Z"),
  lastReplyAt: new Date("2026-10-03T10:00:00Z"),
  images: [],
  authorId: "u1",
  authorName: "mia~",
  authorUsername: "mia",
  authorRole: "user",
  authorBlocked: false,
  authorMuted: false,
  authorCreatedAt: daysAgo(400),
  bodyLength: 120,
  otherReplyCount: 1,
  forumSlug: "guides",
  forumName: "Guides",
};
const page: ThreadPage = {
  thread,
  worlds: [],
  replies: [
    { id: "p1", content: "Thanks, this **helped**. See [my site](https://spam.example).", floor: 1, createdAt: new Date("2026-10-02T12:00:00Z"), authorId: "u2", authorName: `ren "<b>"`, authorUsername: null, authorRole: "user" },
    { id: "p2", content: "   ", floor: 2, createdAt: null, authorId: "u3", authorName: "kai", authorUsername: "kai", authorRole: "user" },
    { id: "p3", content: "Pinned to the guides.", floor: 3, createdAt: new Date("2026-10-03T10:00:00Z"), authorId: "s1", authorName: "Yumina", authorUsername: "yumina", authorRole: "admin" },
  ],
  page: 1,
  pageCount: 1,
  replyTotal: 3,
};
const path = `/app/community/thread/${thread.id}`;

// ── the indexing rule ────────────────────────────────────────────────────────

/** An ordinary member's thread that passes on every count; each test moves one signal. */
const signals: ThreadSignals = {
  ageRating: "all", isPinned: false, isOfficial: false, authorRole: "user", authorBlocked: false, authorMuted: false,
  authorCreatedAt: daysAgo(THREAD_MIN_ACCOUNT_AGE_DAYS), bodyLength: THREAD_MIN_BODY_CHARS, otherReplyCount: THREAD_MIN_OTHER_REPLIES,
};

test("the thresholds are the ones the rule set names", () => {
  assert.equal(THREAD_MIN_ACCOUNT_AGE_DAYS, 7);
  assert.equal(THREAD_MIN_BODY_CHARS, 300);
  assert.equal(THREAD_MIN_OTHER_REPLIES, 1);
  assert.equal(THREAD_REPLIES_PER_PAGE, 20);
  assert.equal(threadIndexable(signals, now), true);
});

test("account age: 7 days old is indexable, a second younger is not", () => {
  assert.equal(threadIndexable({ ...signals, authorCreatedAt: daysAgo(7) }, now), true);
  assert.equal(threadIndexable({ ...signals, authorCreatedAt: new Date(daysAgo(7).getTime() + 1000) }, now), false);
  assert.equal(threadIndexable({ ...signals, authorCreatedAt: null }, now), false, "an unknown age is not old enough");
  // The same thread passes by itself once the account is old enough.
  const young = { ...signals, authorCreatedAt: daysAgo(6) };
  assert.equal(threadIndexable(young, now), false);
  assert.equal(threadIndexable(young, new Date(now.getTime() + 86_400_000)), true);
});

test("body length: with no reply from another member, 300 characters is indexable and 299 is not", () => {
  assert.equal(threadIndexable({ ...signals, otherReplyCount: 0, bodyLength: 300 }, now), true);
  assert.equal(threadIndexable({ ...signals, otherReplyCount: 0, bodyLength: 299 }, now), false);
});

test("replies: one reply from another member is enough for a short post, none is not", () => {
  assert.equal(threadIndexable({ ...signals, bodyLength: 5, otherReplyCount: 1 }, now), true);
  assert.equal(threadIndexable({ ...signals, bodyLength: 5, otherReplyCount: 0 }, now), false);
});

test("both halves of the rule must hold: a long post from a new or muted account is not indexable", () => {
  assert.equal(threadIndexable({ ...signals, bodyLength: 5000, otherReplyCount: 9, authorCreatedAt: daysAgo(1) }, now), false);
  assert.equal(threadIndexable({ ...signals, bodyLength: 5000, otherReplyCount: 9, authorMuted: true }, now), false);
});

test("official, pinned and staff posts are always indexable; adult threads and banned authors never are", () => {
  const thin = { ...signals, bodyLength: 5, otherReplyCount: 0, authorCreatedAt: daysAgo(0), authorMuted: true };
  assert.equal(threadIndexable(thin, now), false);
  assert.equal(threadIndexable({ ...thin, isOfficial: true }, now), true);
  assert.equal(threadIndexable({ ...thin, isPinned: true }, now), true);
  assert.equal(threadIndexable({ ...thin, authorRole: "admin" }, now), true);
  assert.equal(threadIndexable({ ...signals, isPinned: true, ageRating: "r18" }, now), false);
  assert.equal(threadIndexable({ ...signals, isOfficial: true, authorBlocked: true }, now), false);
});

// ── the thread page ──────────────────────────────────────────────────────────

test("page 1 carries the post in full and its replies, flat, each with author, date and text", () => {
  const html = renderThread(page);
  assert.match(html, /<a href="\/app\/community">Community<\/a> · <a href="\/app\/community\/guides">Guides<\/a>/);
  assert.match(html, /<h1 class="pre-h1">How I built a stat-driven RPG<\/h1>/);
  assert.match(html, /<p class="pre-by"><a href="\/@mia">mia~<\/a> · <time datetime="2026-10-01T10:00:00\.000Z">2026-10-01<\/time><\/p>/);
  // The heading that repeats the title is dropped; markdown and markup are gone.
  assert.match(html, /<div class="pre-text"><p>Start with three variables\.<\/p><p>Then add rules\.<\/p><\/div>/);
  assert.doesNotMatch(html, /<img|onerror/);
  assert.match(html, /<h2 class="pre-h2">3 replies<\/h2>/);
  assert.match(html, /<li id="reply-1"><p class="pre-by"><a href="\/app\/users\/u2">ren &quot;&lt;b&gt;&quot;<\/a> · <time[^>]*>2026-10-02<\/time><\/p><div class="pre-text"><p>Thanks, this helped\. See my site\.<\/p><\/div><\/li>/);
  assert.doesNotMatch(html, /reply-2/, "an empty reply is not rendered");
  // Staff are marked on the page.
  assert.match(html, /<a href="\/@yumina">Yumina<\/a> · <span class="pre-staff">Staff<\/span> · <time/);
  assert.doesNotMatch(html, /pre-pager/, "one page, no pager");
});

test("a post that shares worlds links each one, and names the first as what the discussion shares", () => {
  const shared = [
    { id: "w1", publicId: "5c9c88e8", name: "Sakura Season", thumbnailUrl: null, creatorName: "mia~", creatorUsername: "mia" },
    { id: "w2", publicId: "0b0b0b0b", name: `Plum <Rain>`, thumbnailUrl: null, creatorName: "ren", creatorUsername: "ren" },
  ];
  const html = renderThread({ ...page, worlds: shared });
  assert.match(html, /<section class="pre-more pre-shared"><h2 class="pre-h2">Worlds in this post<\/h2><div class="pre-grid"><a class="pre-card" href="\/@mia\/sakura-season-5c9c88e8">/);
  assert.match(html, /href="\/@ren\/plum-rain-0b0b0b0b"/);
  assert.match(html, /Plum &lt;Rain&gt;/);
  assert.match(renderThread({ ...page, worlds: shared.slice(0, 1) }), /World in this post/);
  assert.doesNotMatch(renderThread(page), /pre-shared/, "a post that shares nothing has no block");
  // Only page 1 carries the post and what it shares.
  assert.doesNotMatch(renderThread({ ...page, worlds: shared, page: 2, pageCount: 2, replyTotal: 30 }), /pre-shared/);
  const ld = (buildThreadMeta({ ...page, worlds: shared }, path, now).jsonLd as { "@graph": Array<Record<string, any>> })["@graph"][0]!;
  assert.deepEqual(ld.sharedContent, { "@type": "WebPage", name: "Sakura Season", url: `${PUBLIC_ORIGIN}/@mia/sakura-season-5c9c88e8` });
  assert.equal((buildThreadMeta(page, path, now).jsonLd as { "@graph": Array<Record<string, any>> })["@graph"][0]!.sharedContent, undefined);
});

test("no link written by a member is followable: links in posts and replies are rendered as their text", () => {
  const html = renderThread(page);
  assert.doesNotMatch(html, /spam\.example/);
  // Every link on the page is one of ours: the site's own relative addresses.
  for (const href of html.matchAll(/href="([^"]+)"/g)) assert.match(href[1]!, /^\/(app\/|@)/, href[1]);
});

test("a long thread pages at 20 replies with real prev / next links; a later page repeats the headline and links page 1", () => {
  const first = renderThread({ ...page, pageCount: 4, replyTotal: 65 });
  assert.match(first, new RegExp(`<nav class="pre-by pre-pager">Page 1 of 4 · <a rel="next" href="${path}\\?page=2">Next page</a></nav>`));
  assert.doesNotMatch(first, /rel="prev"/);

  const second = renderThread({ ...page, page: 2, pageCount: 4, replyTotal: 65 });
  assert.match(second, new RegExp(`<h1 class="pre-h1"><a href="${path}">How I built a stat-driven RPG</a></h1>`));
  assert.doesNotMatch(second, /Start with three variables/, "the post itself is on page 1 only");
  assert.match(second, /<ol class="pre-list" start="21">/);
  assert.match(second, new RegExp(`<a rel="prev" href="${path}">Previous page</a> · Page 2 of 4 · <a rel="next" href="${path}\\?page=3">Next page</a>`));

  const last = renderThread({ ...page, page: 4, pageCount: 4, replyTotal: 65 });
  assert.match(last, new RegExp(`<a rel="prev" href="${path}\\?page=3">Previous page</a> · Page 4 of 4</nav>`));
  assert.doesNotMatch(last, /rel="next"/);
  assert.doesNotMatch(first + second + last, /page=all|\/print|view=all/);

  assert.equal(parsePageParam("3"), 3);
  for (const junk of [undefined, null, "", "1", "0", "-2", "2.5", "abc", "2abc", " 2"]) assert.equal(parsePageParam(junk), 1, String(junk));
});

test("an indexable thread is titled thread - forum - Yumina Community and carries DiscussionForumPosting + BreadcrumbList", () => {
  const meta = buildThreadMeta(page, path, now);
  assert.equal(meta.title, "How I built a stat-driven RPG - Guides - Yumina Community");
  assert.equal(meta.url, `${PUBLIC_ORIGIN}${path}`);
  assert.equal(meta.noindex, undefined);
  const graph = (meta.jsonLd as { "@graph": Array<Record<string, any>> })["@graph"];
  const ld = graph.find((n) => n["@type"] === "DiscussionForumPosting")!;
  assert.equal(ld.headline, thread.title);
  assert.equal(ld.url, `${PUBLIC_ORIGIN}${path}`);
  assert.equal(ld.text, "Start with three variables. Then add rules.");
  assert.equal(ld.datePublished, "2026-10-01T10:00:00.000Z");
  assert.equal(ld.dateModified, "2026-10-02T10:00:00.000Z");
  assert.deepEqual(ld.author, { "@type": "Person", name: "mia~", url: `${PUBLIC_ORIGIN}/@mia` });
  assert.equal(ld.commentCount, 3);
  assert.deepEqual(ld.interactionStatistic, { "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: 7 });
  assert.deepEqual(ld.isPartOf, { "@type": "CollectionPage", name: "Guides", url: `${PUBLIC_ORIGIN}/app/community/guides` });
  // The replies on this page, each with author, date and text; the empty one is left out.
  assert.equal(ld.comment.length, 2);
  assert.deepEqual(Object.keys(ld.comment[0]).sort(), ["@type", "author", "datePublished", "text"]);
  assert.equal(ld.comment[0].text, "Thanks, this helped. See my site.");
  assert.equal(ld.comment[0].url, undefined, "a reply has no address of its own");
  // Staff are marked in the markup.
  assert.equal(ld.comment[1].author.jobTitle, "Yumina staff");
  assert.equal((ld.author as Record<string, unknown>).jobTitle, undefined);
  const crumbs = graph.find((n) => n["@type"] === "BreadcrumbList")!;
  assert.deepEqual(crumbs.itemListElement.map((i: { name: string; item: string }) => [i.name, i.item]), [
    ["Community", `${PUBLIC_ORIGIN}/app/community`],
    ["Guides", `${PUBLIC_ORIGIN}/app/community/guides`],
    [thread.title, `${PUBLIC_ORIGIN}${path}`],
  ]);
});

test("the description is the opening of the post cut near 200 characters at a word boundary", () => {
  const long = { ...thread, content: "Each variable has a floor and a ceiling and the rules only fire between them. ".repeat(8) };
  const { description } = buildThreadMeta({ ...page, thread: long }, path, now);
  assert.ok(description.length <= 201 && description.length >= 120, String(description.length));
  assert.match(description, /^Each variable has a floor/);
  assert.match(description, /(\.|…)$/);
  assert.doesNotMatch(description.replace(/…$/, ""), /\S…|\bbetw$/, "never cut inside a word");
});

test("each page of a thread is its own canonical address with Page N in the title; the posting still names page 1", () => {
  const meta = buildThreadMeta({ ...page, page: 3, pageCount: 4, replyTotal: 65 }, path, now);
  assert.equal(meta.title, "How I built a stat-driven RPG - Page 3 - Guides - Yumina Community");
  assert.equal(meta.url, `${PUBLIC_ORIGIN}${path}?page=3`);
  assert.equal(threadPageUrl(thread.id, 1), `${PUBLIC_ORIGIN}${path}`);
  const ld = (meta.jsonLd as { "@graph": Array<Record<string, any>> })["@graph"][0]!;
  assert.equal(ld.url, `${PUBLIC_ORIGIN}${path}`);
  assert.equal(ld.mainEntityOfPage, `${PUBLIC_ORIGIN}${path}?page=3`);
  assert.equal(ld.commentCount, 65);
});

test("a public thread that does not pass the rule keeps its title and carries noindex, in the tag and the header value", () => {
  const thin = { ...thread, otherReplyCount: 0, bodyLength: 120 };
  const meta = buildThreadMeta({ ...page, thread: thin }, path, now);
  assert.equal(meta.noindex, true);
  assert.equal(meta.status, undefined, "it is still a page");
  assert.equal(meta.title, "How I built a stat-driven RPG - Guides - Yumina Community");
  assert.equal(meta.jsonLd, undefined);
  assert.equal(robotsValue(meta), "noindex");
  const html = injectMeta(`<html lang="en"><head><title>x</title></head></html>`, meta);
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  assert.equal(robotsValue({}), "noindex, nofollow", "private pages stay nofollow as before");
});

test("a thread a visitor cannot open, or one by a banned author, renders nothing and keeps the generic meta", () => {
  for (const hidden of [{ ...thread, ageRating: "r18" }, { ...thread, authorBlocked: true }]) {
    assert.equal(renderThread({ ...page, thread: hidden }), "");
    const meta = buildThreadMeta({ ...page, thread: hidden }, path, now);
    assert.equal(meta.noindex, true);
    assert.equal(meta.title, "Yumina");
    assert.equal(meta.jsonLd, undefined);
    assert.equal(robotsValue(meta), "noindex, nofollow");
  }
});

test("a thread, board or event that does not exist is a 404", async () => {
  for (const missing of [
    "/app/community/thread/0d9f6a54-1111-4222-8333-444455556666",
    "/app/community/thread/not-an-id",
    "/app/community/no-such-board",
    "/app/community/events/0d9f6a54-1111-4222-8333-444455556666",
  ]) {
    const meta = await getMetaForPath(missing);
    assert.equal(meta.status, 404, missing);
    assert.equal(meta.noindex, true, missing);
  }
  // The community's own pages are still pages.
  assert.equal((await getMetaForPath("/app/community")).status, undefined);
  assert.equal((await getMetaForPath("/app/community/new")).status, undefined);
});

test("sorted, filtered and tracked views point at the plain address; a search view is kept out of search", async () => {
  const plain = await getMetaForPath("/app/community");
  assert.equal(plain.noindex, undefined);
  // The canonical URL is built from the path alone, so ?sort=, ?utm_source= and the rest never reach it.
  assert.equal(plain.url, `${PUBLIC_ORIGIN}/app/community`);
  const search = await getMetaForPath("/app/community", { search: true });
  assert.equal(search.noindex, true);
  assert.equal(search.url, `${PUBLIC_ORIGIN}/app/community`);
  assert.equal(robotsValue(search), "noindex");
  // A search term on a page outside the community changes nothing.
  assert.equal((await getMetaForPath("/app/library", { search: true })).noindex, undefined);
});

test("the community child lists boards, events and indexable threads with lastmod, and joins the index only when it has entries", () => {
  const urls = communitySitemapUrls({
    forums: [{ id: "f1", name: "Guides", slug: "guides", description: "", lastActivityAt: new Date("2026-10-03T10:00:00Z") }],
    events: [{ id: "e1", updatedAt: new Date("2026-11-01T00:00:00Z") }],
    threads: [{ ...signals, id: "t1", forumId: "f1", updatedAt: new Date("2026-10-02T10:00:00Z"), lastReplyAt: new Date("2026-10-03T10:00:00Z") }],
  });
  const locs = urls.map((u) => /<loc>([^<]+)<\/loc>/.exec(u.xml)![1]);
  assert.deepEqual(locs, [`${PUBLIC_ORIGIN}/app/community/guides`, `${PUBLIC_ORIGIN}/app/community/events/e1`, `${PUBLIC_ORIGIN}/app/community/thread/t1`]);
  assert.deepEqual(urls.map((u) => u.lastmod), ["2026-10-03", "2026-11-01", "2026-10-03"], "a thread is dated by its last reply when that is newer");
  assert.ok(urls.every((u) => !/[?#]/.test(u.xml)), "no page, reply or sorted addresses");

  const withCommunity = assembleSitemaps({ pages: [], worlds: [], community: urls });
  assert.deepEqual([...withCommunity.children.keys()], ["sitemap-pages.xml", "sitemap-worlds.xml", "sitemap-community.xml"]);
  assert.ok(withCommunity.index.includes(`<loc>${PUBLIC_ORIGIN}/sitemap-community.xml</loc>\n    <lastmod>2026-11-01</lastmod>`));
  const without = assembleSitemaps({ pages: [], worlds: [], community: [] });
  assert.deepEqual([...without.children.keys()], ["sitemap-pages.xml", "sitemap-worlds.xml"]);
  // Past the per-file limit it splits like the other children.
  const split = assembleSitemaps({ pages: [], worlds: [], community: [...urls, ...urls] }, 4);
  assert.deepEqual([...split.children.keys()], ["sitemap-pages.xml", "sitemap-worlds.xml", "sitemap-community-1.xml", "sitemap-community-2.xml"]);
});

test("community, board and event pages list their content as escaped text and links", () => {
  const item = { id: "t1", title: `Hello <world>`, createdAt: new Date("2026-10-01T00:00:00Z"), lastReplyAt: null, replyCount: 1, authorName: "mia~", forumSlug: "guides", forumName: "Guides" };
  const community = renderCommunity({
    forums: [{ id: "f1", name: "Guides", slug: "guides", description: "How-tos and **tips**." }],
    threads: [item],
    events: [],
  });
  assert.match(community, /<h2 class="pre-h2">Forums<\/h2><ul class="pre-list pre-text"><li><a href="\/app\/community\/guides">Guides<\/a><p>How-tos and tips\.<\/p><\/li>/);
  assert.match(community, /<li><a href="\/app\/community\/thread\/t1">Hello &lt;world&gt;<\/a> <span class="pre-card__by">mia~ · <a href="\/app\/community\/guides">Guides<\/a> · <time[^>]*>2026-10-01<\/time> · 1 reply<\/span><\/li>/);
  assert.doesNotMatch(community, /Events/);

  const forum = renderForum({ forum: { id: "f1", name: "Guides", slug: "guides", description: "" }, threads: [item] });
  assert.match(forum, /<h1 class="pre-h1">Guides<\/h1><ol class="pre-list pre-text"><li><a href="\/app\/community\/thread\/t1">/);

  const event = renderEvent({
    id: "e1", title: "Autumn Jam", introduction: "Build a world in **two weeks**.", rewardDescription: "Three winners.", lang: "en", status: "live",
    posterImageUrl: null, bannerImageUrl: null, registrationOpensAt: new Date("2026-11-01T00:00:00Z"), registrationClosesAt: new Date("2026-11-15T00:00:00Z"), updatedAt: null,
  });
  assert.match(event, /<h1 class="pre-h1">Autumn Jam<\/h1><p class="pre-by"><time[^>]*>2026-11-01<\/time> – <time[^>]*>2026-11-15<\/time><\/p><div class="pre-text"><p>Build a world in two weeks\.<\/p>/);
  assert.match(event, /<h2 class="pre-h2">Rewards<\/h2><div class="pre-text"><p>Three winners\.<\/p>/);
});

test("an opening is read as plain text: macros, markup and state directives removed", () => {
  const text = cleanOpening(
    `<style>.x{color:red}</style>*The bell rings.* {{user}} looks at {{char}}.\n\n[hp: add 5] "Late again," she says. {{getvar::mood}}\n\n<div class="ui">Second scene.</div>`,
    "Sakura",
  );
  assert.equal(text, `The bell rings. you looks at Sakura.\n\n"Late again," she says.\n\nSecond scene.`);
  assert.equal(cleanOpening(null), "");
  assert.ok(cleanOpening("word ".repeat(2000)).length <= 1501);
});

test("a world's search description is never just the creator's name when it has words of its own", () => {
  const world = { name: "Sakura Season", description: "", creatorName: "mia~", tags: ["恋爱", "校园"] };
  const opening = "The bell rings over the empty schoolyard and the first petals come down with the rain. You are late again.";
  // No description: the opening carries it.
  assert.match(worldDescription(world, opening), /^The bell rings over the empty schoolyard/);
  // A few words of description: the opening follows them.
  const short = worldDescription({ ...world, description: "A spring story." }, opening);
  assert.match(short, /^A spring story\. The bell rings/);
  assert.ok(short.length <= 160, short);
  // A real description stands alone.
  const long = "A slow spring in a small town where every choice you make changes who waits for you at the station.";
  assert.equal(worldDescription({ ...world, description: long }, opening), long);
  // Neither: what is known about the world, not "By mia~."
  assert.equal(worldDescription(world, null), "Sakura Season: an AI roleplay world by mia~ on Yumina. Tags: 恋爱, 校园.");
  assert.notEqual(worldDescription({ ...world, tags: [] }, null), "By mia~.");
  // A short description with no opening keeps today's wording.
  assert.equal(worldDescription({ ...world, description: "A spring story." }, null), "A spring story. By mia~.");
});
