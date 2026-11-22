import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, before, beforeEach, mock, test } from "node:test";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { follows, user, worlds } from "../db/schema.js";
import { leaderboardsSql } from "../db/leaderboards.js";
import { auth } from "../lib/auth.js";
import { LEADERBOARD_MAX_BOARDS, cleanBoardName, leaderboardRoutes } from "./leaderboards.js";

const app = new Hono().route("/api/leaderboards", leaderboardRoutes);
const p = `lb-${crypto.randomUUID().slice(0, 8)}`;
const ids = { author: `${p}-author`, ann: `${p}-ann`, bea: `${p}-bea`, cy: `${p}-cy` };
const card = { zh: "", en: "", draft: "", other: "" };

function call(path: string, actor: string, method = "GET", body?: unknown) {
  return app.request(path, {
    method,
    headers: { "x-test-user": actor, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const json = async (r: Response) => (await r.json()) as { data?: any; error?: string; code?: string };
const submit = (who: string, worldId: string, board: string, body: unknown) => call(`/api/leaderboards/${worldId}/${encodeURIComponent(board)}`, who, "POST", body);
const read = (who: string, worldId: string, board: string, q = "") => call(`/api/leaderboards/${worldId}/${encodeURIComponent(board)}${q}`, who);

before(async () => {
  await db.insert(user).values([
    { id: ids.author, name: "Author", email: `${ids.author}@test.invalid` },
    { id: ids.ann, name: "Ann", email: `${ids.ann}@test.invalid` },
    { id: ids.bea, name: "Bea", email: `${ids.bea}@test.invalid` },
    { id: ids.cy, name: "Cy", email: `${ids.cy}@test.invalid` },
  ]);
  const group = `${p}-group`;
  const schema = { id: "w", name: "Pinball", entries: [], variables: [] };
  const [zh] = await db.insert(worlds).values({ creatorId: ids.author, name: "弹球", status: "published", languageGroupId: group, schema }).returning();
  const [en] = await db.insert(worlds).values({ creatorId: ids.author, name: "Pinball", status: "published", languageGroupId: group, schema }).returning();
  const [draft] = await db.insert(worlds).values({ creatorId: ids.author, name: "Draft", status: "draft", schema }).returning();
  const [other] = await db.insert(worlds).values({ creatorId: ids.author, name: "Other", status: "published", schema }).returning();
  Object.assign(card, { zh: zh!.id, en: en!.id, draft: draft!.id, other: other!.id });
  // Ann and Bea are friends (mutual follows).
  await db.insert(follows).values([{ followerId: ids.ann, followingId: ids.bea }, { followerId: ids.bea, followingId: ids.ann }]);
});

beforeEach(() => {
  mock.method(auth.api, "getSession", async ({ headers }: { headers: Headers }) => {
    const id = headers.get("x-test-user");
    return id ? { user: { id, name: id }, session: { id: `${id}-session`, userId: id, expiresAt: new Date(Date.now() + 60_000), token: "fixture" } } : null;
  });
});
afterEach(() => mock.restoreAll());

test("the SQL file is the boot DDL", () => {
  const file = readFileSync(new URL("../../scripts/leaderboards.sql", import.meta.url), "utf8");
  assert.equal(file.replace(/^(--.*\n)+/, ""), leaderboardsSql());
});

test("board names", () => {
  assert.equal(cleanBoardName(" 最高分 "), "最高分");
  assert.equal(cleanBoardName(""), null);
  assert.equal(cleanBoardName("x".repeat(41)), null);
  assert.equal(cleanBoardName("a\nb"), "ab");
});

test("each player keeps their best; ranks share ties; every language version shares the board", async () => {
  let r = await json(await submit(ids.ann, card.zh, "最高分", { score: 1200, details: { ball: "steel" } }));
  assert.deepEqual([r.data.best, r.data.rank, r.data.improved, r.data.order], [1200, 1, true, "desc"]);
  r = await json(await submit(ids.ann, card.zh, "最高分", { score: 900 }));
  assert.deepEqual([r.data.best, r.data.improved], [1200, false], "a lower score does not replace the best");
  r = await json(await submit(ids.bea, card.en, "最高分", { score: 1500 }));
  assert.equal(r.data.rank, 1, "the English version writes the same board");
  await submit(ids.cy, card.zh, "最高分", { score: 1200 });

  const top = await json(await read(ids.ann, card.en, "最高分"));
  assert.equal(top.data.total, 3);
  assert.deepEqual(top.data.entries.map((e: any) => [e.name, e.score, e.rank]), [["Bea", 1500, 1], ["Ann", 1200, 2], ["Cy", 1200, 2]]);
  assert.deepEqual(top.data.entries.find((e: any) => e.name === "Ann").details, { ball: "steel" });
  assert.equal(top.data.entries.find((e: any) => e.name === "Ann").me, true);
  assert.deepEqual(top.data.me, { rank: 2, score: 1200 });

  const friends = await json(await read(ids.ann, card.zh, "最高分", "?range=friends"));
  assert.deepEqual(friends.data.entries.map((e: any) => e.name), ["Bea", "Ann"], "friends: me and my mutual follows only");
  const around = await json(await read(ids.cy, card.zh, "最高分", "?range=around&limit=1"));
  assert.equal(around.data.entries.length, 1);
});

test("a fastest-time board keeps the lowest score", async () => {
  let r = await json(await submit(ids.ann, card.zh, "通关用时", { score: 95.5, order: "asc" }));
  assert.equal(r.data.order, "asc");
  r = await json(await submit(ids.ann, card.zh, "通关用时", { score: 120, order: "desc" }));
  assert.deepEqual([r.data.best, r.data.improved, r.data.order], [95.5, false, "asc"], "the order is the first score's");
  r = await json(await submit(ids.ann, card.zh, "通关用时", { score: 80 }));
  assert.equal(r.data.best, 80);
});

test("bad input, unpublished cards and the board limit", async () => {
  assert.equal((await submit(ids.ann, card.zh, "最高分", { score: "999" })).status, 400);
  assert.equal((await submit(ids.ann, card.zh, "最高分", { score: Number.MAX_VALUE })).status, 400);
  assert.equal((await submit(ids.ann, card.zh, "最高分", { score: 1, details: "x".repeat(600) })).status, 400);
  assert.equal((await submit(ids.ann, card.draft, "最高分", { score: 1 })).status, 404, "someone else's draft");
  assert.equal((await submit(ids.author, card.draft, "最高分", { score: 1 })).status, 200, "the author can test their own draft");
  assert.equal((await read(ids.ann, card.other, "nothing-yet")).status, 200);
  for (let i = 0; i < LEADERBOARD_MAX_BOARDS; i++) await submit(ids.author, card.other, `b${i}`, { score: i });
  const over = await submit(ids.author, card.other, "one-too-many", { score: 1 });
  assert.equal(over.status, 409);
  assert.equal((await json(over)).code, "too-many-boards");
});
