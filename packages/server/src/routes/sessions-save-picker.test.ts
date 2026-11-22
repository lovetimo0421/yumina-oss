import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions, user, worlds } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { firstRecapLine, SAVE_SEARCH_SNIPPET_SESSIONS, SAVE_SEARCH_SNIPPETS, searchSaves } from "../lib/save-picker.js";
import { sessionRoutes } from "./sessions.js";

const owner = "picker-owner";
const stranger = "picker-stranger";
let worldId = "";
let otherWorldId = "";
let groupWorldId = "";
const groupId = "picker-group";
const base = Date.parse("2026-03-01T00:00:00Z");
const ids = { main: "", recap: "", named: "", stranger: "", otherCard: "", sibling: "", playtest: "" };
let account: typeof user.$inferSelect;

async function addSession(values: Partial<typeof playSessions.$inferInsert> & { userId: string; worldId: string }) {
  const [row] = await db.insert(playSessions).values({ state: {}, ...values }).returning();
  return row!.id;
}
async function addMessages(sessionId: string, contents: Array<string | { role: "user" | "assistant"; content: string }>, startMs = 0) {
  await db.insert(messages).values(contents.map((entry, index) => {
    const { role, content } = typeof entry === "string" ? { role: (index % 2 ? "user" : "assistant") as "user" | "assistant", content: entry } : entry;
    return { id: `${sessionId}-m${index + 1}`, sessionId, role, content, createdAt: new Date(base + startMs + index * 1000) };
  }));
}

before(async () => {
  [account] = await db.insert(user).values([
    { id: owner, name: "Owner", username: "picker_owner", email: "picker-owner@test.local", emailVerified: true },
    { id: stranger, name: "Stranger", username: "picker_stranger", email: "picker-stranger@test.local", emailVerified: true },
  ]).returning() as [typeof user.$inferSelect];
  const [world, other, sibling] = await db.insert(worlds).values([
    { creatorId: owner, name: "Picker", schema: {}, languageGroupId: groupId, language: "en" },
    { creatorId: owner, name: "Other", schema: {} },
    { creatorId: owner, name: "Picker (zh)", schema: {}, languageGroupId: groupId, language: "zh" },
  ]).returning();
  worldId = world!.id; otherWorldId = other!.id; groupWorldId = sibling!.id;

  ids.main = await addSession({ userId: owner, worldId, updatedAt: new Date(base + 900_000) });
  await addMessages(ids.main, [
    "The opening: a lantern flickers in the rain.",              // #1
    { role: "user", content: "  I walk to the\n\nold   mill.  " }, // #2 (first player message)
    "I ask about the 100% pure silver key.",                     // #3
    "She shrugs. 'snake_case is not a spell.'",                  // #4
    "A path with a back\\slash in it.",                          // #5
    "The LANTERN goes out.",                                      // #6
    "Another lantern, far away.",                                 // #7
    "A third lantern.",                                           // #8
    "银色的钥匙在灯笼下闪光。",                                      // #9
  ]);
  ids.recap = await addSession({
    userId: owner, worldId, updatedAt: new Date(base + 800_000),
    summary: "## Story So Far\n\n- **Mira** found the lantern in the mill.\nMore.\n## Major Open Threads\n- x",
  });
  await addMessages(ids.recap, ["Mira holds the lantern.", { role: "user", content: "hello" }]);
  ids.named = await addSession({ userId: owner, worldId, name: "Main run", updatedAt: new Date(base + 700_000) });
  await addMessages(ids.named, ["No match here.", { role: "user", content: "Me neither." }]);
  ids.sibling = await addSession({ userId: owner, worldId: groupWorldId, updatedAt: new Date(base + 600_000) });
  await addMessages(ids.sibling, ["一盏 lantern 在窗边。"]);
  ids.otherCard = await addSession({ userId: owner, worldId: otherWorldId });
  await addMessages(ids.otherCard, ["a lantern on another card"]);
  ids.stranger = await addSession({ userId: stranger, worldId });
  await addMessages(ids.stranger, ["a lantern in someone else's story"]);
  ids.playtest = await addSession({ userId: owner, worldId, ephemeral: true });
  await addMessages(ids.playtest, ["a lantern in a Studio playtest"]);
});
after(async () => { const client = (db as unknown as { $client: { closed?: boolean; close(): Promise<void> } }).$client; if (!client.closed) await client.close(); });

test("search finds only the caller's own saves of that card, grouped per save with counts", async () => {
  const result = await searchSaves(db, { userId: owner, worldId }, "lantern");
  assert.deepEqual(result.map((m) => [m.sessionId, m.hitCount]), [[ids.main, 4], [ids.recap, 1]]);
  const ids_ = result.map((m) => m.sessionId);
  for (const excluded of [ids.stranger, ids.otherCard, ids.playtest, ids.sibling]) assert.ok(!ids_.includes(excluded));
  assert.deepEqual(await searchSaves(db, { userId: stranger, worldId }, "mill"), []);
});

test("snippets: newest first, at most three per save, numbered by place in the save", async () => {
  const [main] = await searchSaves(db, { userId: owner, worldId }, "LaNtErN");
  assert.equal(main!.hits.length, SAVE_SEARCH_SNIPPETS);
  assert.deepEqual(main!.hits.map((hit) => [hit.id, hit.position]), [[`${ids.main}-m8`, 8], [`${ids.main}-m7`, 7], [`${ids.main}-m6`, 6]]);
  assert.equal(main!.hits[2]!.snippet, "The LANTERN goes out.");
  assert.equal(main!.hits[2]!.clippedStart, false);
  // The query's whitespace is folded; so is the snippet's.
  const [mill] = await searchSaves(db, { userId: owner, worldId }, "  walk \n to ");
  assert.equal(mill!.hits[0]!.position, 2);
  assert.equal(mill!.hits[0]!.snippet, "I walk to the old mill.");
});

test("LIKE wildcards and the escape character match literally", async () => {
  assert.deepEqual((await searchSaves(db, { userId: owner, worldId }, "100%"))[0]!.hits.map((h) => h.position), [3]);
  assert.deepEqual((await searchSaves(db, { userId: owner, worldId }, "%")).flatMap((m) => m.hits.map((h) => h.position)), [3]);
  assert.deepEqual((await searchSaves(db, { userId: owner, worldId }, "snake_case"))[0]!.hits.map((h) => h.position), [4]);
  assert.deepEqual(await searchSaves(db, { userId: owner, worldId }, "snakeXcase"), []);
  assert.deepEqual((await searchSaves(db, { userId: owner, worldId }, "back\\slash"))[0]!.hits.map((h) => h.position), [5]);
  assert.deepEqual((await searchSaves(db, { userId: owner, worldId }, "钥匙"))[0]!.hits.map((h) => h.position), [9]);
  assert.deepEqual(await searchSaves(db, { userId: owner, worldId }, "   "), []);
});

test("a language group searches every version of the card; no scope searches nothing", async () => {
  const grouped = await searchSaves(db, { userId: owner, languageGroupId: groupId }, "lantern");
  assert.deepEqual(grouped.map((m) => m.sessionId), [ids.main, ids.recap, ids.sibling]);
  assert.deepEqual(await searchSaves(db, { userId: owner }, "lantern"), []);
});

test("only the first saves carry snippets; every match still counts", async () => {
  const many = Array.from({ length: SAVE_SEARCH_SNIPPET_SESSIONS + 3 }, (_, i) => i);
  const bulkWorld = (await db.insert(worlds).values({ creatorId: owner, name: "Bulk", schema: {} }).returning())[0]!.id;
  const created: string[] = [];
  for (const i of many) {
    const id = await addSession({ userId: owner, worldId: bulkWorld, updatedAt: new Date(base + i * 1000) });
    created.push(id);
    await addMessages(id, [`needle ${i}`, `needle again ${i}`, `x`, `needle ${i} three`, `needle ${i} four`]);
  }
  const result = await searchSaves(db, { userId: owner, worldId: bulkWorld }, "needle");
  assert.equal(result.length, many.length);
  assert.equal(result[0]!.sessionId, created.at(-1), "most recently played first");
  assert.ok(result.every((m) => m.hitCount === 4));
  assert.ok(result.slice(0, SAVE_SEARCH_SNIPPET_SESSIONS).every((m) => m.hits.length === SAVE_SEARCH_SNIPPETS));
  assert.ok(result.slice(SAVE_SEARCH_SNIPPET_SESSIONS).every((m) => m.hits.length === 0));
  assert.deepEqual(result[0]!.hits.map((h) => h.position), [5, 4, 2]);
});

test("recap subtitle skips headings and markup", () => {
  assert.equal(firstRecapLine("## Story So Far\n\n- **Mira** found it.\nMore."), "Mira found it.");
  assert.equal(firstRecapLine("## Story So Far\n"), null);
  assert.equal(firstRecapLine(null), null);
  assert.ok(firstRecapLine(`## A\n${"x".repeat(300)}`)!.length <= 91);
});

test("HTTP: list carries subtitle + pinnedAt; search and pin are owner-only", async () => {
  let current = account;
  const login = mock.method(auth.api, "getSession", async () => ({ user: current, session: { id: "test-login", userId: current.id, expiresAt: new Date(Date.now() + 60000) } }));
  const request = (path: string, method = "GET", body?: object) => sessionRoutes.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const list = await request(`/?worldId=${worldId}`);
    assert.equal(list.status, 200);
    const { data } = await list.json() as { data: Array<{ id: string; subtitle: string | null; pinnedAt: string | null }> };
    const byId = new Map(data.map((row) => [row.id, row]));
    assert.equal(byId.get(ids.main)!.subtitle, "I walk to the old mill.");
    assert.equal(byId.get(ids.recap)!.subtitle, "Mira found the lantern in the mill.");
    assert.equal(byId.get(ids.named)!.subtitle, null, "named saves need no subtitle");
    assert.equal(byId.get(ids.main)!.pinnedAt, null);

    const search = await request(`/search?worldId=${worldId}&q=lantern`);
    assert.equal(search.status, 200);
    const found = (await search.json() as { data: Array<{ sessionId: string }> }).data;
    assert.deepEqual(found.map((m) => m.sessionId), [ids.main, ids.recap]);
    assert.equal((await request(`/search?q=lantern`)).status, 400);

    const [beforePin] = await db.select({ updatedAt: playSessions.updatedAt }).from(playSessions).where(eq(playSessions.id, ids.recap));
    const pin = await request(`/${ids.recap}/pin`, "PUT", { pinned: true });
    assert.equal(pin.status, 200);
    assert.ok((await pin.json() as { data: { pinnedAt: string | null } }).data.pinnedAt);
    const [afterPin] = await db.select({ updatedAt: playSessions.updatedAt, pinnedAt: playSessions.pinnedAt }).from(playSessions).where(eq(playSessions.id, ids.recap));
    assert.ok(afterPin!.pinnedAt);
    assert.equal(afterPin!.updatedAt?.getTime(), beforePin!.updatedAt?.getTime(), "pinning is not playing");
    assert.equal((await request(`/${ids.recap}/pin`, "PUT", { pinned: "yes" })).status, 400);

    current = (await db.select().from(user).where(eq(user.id, stranger)))[0]!;
    assert.equal((await request(`/${ids.recap}/pin`, "PUT", { pinned: false })).status, 404);
    const theirs = await request(`/search?worldId=${worldId}&q=lantern`);
    assert.deepEqual((await theirs.json() as { data: Array<{ sessionId: string }> }).data.map((m) => m.sessionId), [ids.stranger]);

    current = account;
    assert.equal((await request(`/${ids.recap}/pin`, "PUT", { pinned: false })).status, 200);
    const [unpinned] = await db.select({ pinnedAt: playSessions.pinnedAt }).from(playSessions).where(eq(playSessions.id, ids.recap));
    assert.equal(unpinned!.pinnedAt, null);
  } finally { login.mock.restore(); }
});
