import "../test/database-fixture.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db/index.js";
import { messages, playSessions, user, worlds } from "../db/schema.js";
import {
  MESSAGE_SEARCH_LIMIT_MAX,
  escapeLikePattern,
  normalizeSearchQuery,
  searchSessionMessages,
  snippetAround,
} from "./message-search.js";
import { countMessagesBefore, loadMessagePage } from "./message-page.js";

const owner = "search-owner";
const stranger = "search-stranger";
let sessionId: string;
let otherSessionId: string;

before(async () => {
  await db.insert(user).values([
    { id: owner, name: "Owner", email: "search-owner@test.local", emailVerified: true },
    { id: stranger, name: "Stranger", email: "search-stranger@test.local", emailVerified: true },
  ]);
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Search", schema: {} }).returning();
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: {} }).returning();
  const [other] = await db.insert(playSessions).values({ userId: stranger, worldId: world!.id, state: {} }).returning();
  sessionId = session!.id;
  otherSessionId = other!.id;
  const base = Date.parse("2026-03-01T00:00:00Z");
  const contents = [
    "The opening: a lantern flickers in the rain.",                 // #1
    "I ask about the 100% pure silver key.",                        // #2
    "She shrugs. 'snake_case is not a spell.'",                     // #3
    `${"Long road. ".repeat(40)}Then the LANTERN goes out.${" Silence.".repeat(40)}`, // #4
    "A path with a back\\slash in it.",                             // #5
    "银色的钥匙在灯笼下闪光。",                                         // #6
  ];
  await db.insert(messages).values(contents.map((content, index) => ({
    id: `search-${index + 1}`, sessionId, role: index % 2 ? ("user" as const) : ("assistant" as const),
    content, createdAt: new Date(base + index * 1000),
  })));
  // Many rows that match "filler" to test the limit.
  await db.insert(messages).values(Array.from({ length: MESSAGE_SEARCH_LIMIT_MAX + 5 }, (_, index) => ({
    id: `filler-${String(index).padStart(3, "0")}`, sessionId, role: "assistant" as const,
    content: `filler line ${index}`, createdAt: new Date(base + 10_000 + index * 1000),
  })));
  await db.insert(messages).values({
    id: "stranger-1", sessionId: otherSessionId, role: "assistant", content: "a lantern in someone else's story",
    createdAt: new Date(base),
  });
});
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

test("a session that is not the caller's reads as missing", async () => {
  assert.equal(await searchSessionMessages(db, { sessionId: otherSessionId, userId: owner, query: "lantern" }), null);
  assert.equal(await searchSessionMessages(db, { sessionId, userId: stranger, query: "lantern" }), null);
  assert.equal(await searchSessionMessages(db, { sessionId: "no-such-session", userId: owner, query: "lantern" }), null);
});

test("matches case-insensitively, newest first, with session positions and a snippet around the hit", async () => {
  const result = await searchSessionMessages(db, { sessionId, userId: owner, query: "lantern" });
  assert.ok(result);
  assert.deepEqual(result.hits.map((hit) => [hit.id, hit.position]), [["search-4", 4], ["search-1", 1]]);
  assert.equal(result.hasMore, false);
  const long = result.hits[0]!;
  assert.match(long.snippet, /LANTERN/);
  assert.ok(long.snippet.length < 220, "snippet is cut around the hit");
  assert.equal(long.clippedStart, true);
  assert.equal(long.clippedEnd, true);
  const short = result.hits[1]!;
  assert.equal(short.snippet, "The opening: a lantern flickers in the rain.");
  assert.equal(short.clippedStart, false);
  assert.equal(short.clippedEnd, false);
  assert.match(short.createdAt, /^2026-03-01T00:00:00\.000000Z$/);
  // Nothing from another player's session leaks in.
  assert.ok(!result.hits.some((hit) => hit.id === "stranger-1"));
});

test("LIKE wildcards and the escape character match literally", async () => {
  const percent = await searchSessionMessages(db, { sessionId, userId: owner, query: "100%" });
  assert.deepEqual(percent!.hits.map((hit) => hit.id), ["search-2"]);
  const lonePercent = await searchSessionMessages(db, { sessionId, userId: owner, query: "%" });
  assert.deepEqual(lonePercent!.hits.map((hit) => hit.id), ["search-2"]);
  const underscore = await searchSessionMessages(db, { sessionId, userId: owner, query: "e_c" });
  assert.deepEqual(underscore!.hits.map((hit) => hit.id), ["search-3"]);
  const backslash = await searchSessionMessages(db, { sessionId, userId: owner, query: "back\\slash" });
  assert.deepEqual(backslash!.hits.map((hit) => hit.id), ["search-5"]);
  const cjk = await searchSessionMessages(db, { sessionId, userId: owner, query: "钥匙" });
  assert.deepEqual(cjk!.hits.map((hit) => [hit.id, hit.position]), [["search-6", 6]]);
});

test("results are capped at the limit and report that more exist", async () => {
  const capped = await searchSessionMessages(db, { sessionId, userId: owner, query: "filler", limit: 10 });
  assert.equal(capped!.hits.length, 10);
  assert.equal(capped!.hasMore, true);
  assert.equal(capped!.hits[0]!.id, `filler-${String(MESSAGE_SEARCH_LIMIT_MAX + 4).padStart(3, "0")}`);
  assert.equal(capped!.hits[0]!.position, 6 + MESSAGE_SEARCH_LIMIT_MAX + 5);
  const huge = await searchSessionMessages(db, { sessionId, userId: owner, query: "filler", limit: 10_000 });
  assert.equal(huge!.hits.length, MESSAGE_SEARCH_LIMIT_MAX);
  assert.equal(huge!.hasMore, true);
  // Paging: everything older than the last hit, without repeats or gaps.
  const seen = [...capped!.hits.map((hit) => hit.id)];
  let cursor = capped!.hits.at(-1)!.position;
  for (;;) {
    const page = await searchSessionMessages(db, { sessionId, userId: owner, query: "filler", limit: 40, beforePosition: cursor });
    seen.push(...page!.hits.map((hit) => hit.id));
    if (!page!.hasMore) break;
    cursor = page!.hits.at(-1)!.position;
  }
  assert.equal(seen.length, MESSAGE_SEARCH_LIMIT_MAX + 5);
  assert.equal(new Set(seen).size, seen.length);
  const empty = await searchSessionMessages(db, { sessionId, userId: owner, query: "   " });
  assert.deepEqual(empty, { hits: [], hasMore: false });
});

test("query helpers", () => {
  assert.equal(escapeLikePattern("50%_off\\now"), "50\\%\\_off\\\\now");
  assert.equal(normalizeSearchQuery("  a \n  b  "), "a b");
  assert.equal(normalizeSearchQuery("x".repeat(500)).length, 200);
  assert.equal(normalizeSearchQuery(42), "");
  const cut = snippetAround(`${"a".repeat(200)} needle ${"b".repeat(200)}`, "NEEDLE", false, false);
  assert.match(cut.snippet, /needle/);
  assert.equal(cut.clippedStart, true);
  assert.equal(cut.clippedEnd, true);
});

test("a page reports how many rows precede it, so rows are numbered by session position", async () => {
  const page = await loadMessagePage(db, sessionId, 20);
  assert.equal(page.hasMore, true);
  const total = 6 + MESSAGE_SEARCH_LIMIT_MAX + 5;
  const first = page.messages[0]!;
  assert.equal(await countMessagesBefore(db, sessionId, { id: first.id, createdAt: first.createdAt }), total - 20);
  assert.equal(await countMessagesBefore(db, sessionId, { id: "search-1", createdAt: "2026-03-01T00:00:00.000000Z" }), 0);
});
