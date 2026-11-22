import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { Hono, type Handler } from "hono";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import {
  assetFolders, assets, playSessions, user, userAssets, worldCollaborators, worldFolderBindings,
  worldPendingEdits, worlds, worldVersions,
} from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { getWorldAccess } from "../lib/world-collaborators.js";
import { submitPendingEdit } from "../lib/pending-edit.js";
import type { AppEnv } from "../lib/types.js";
import { worldCollaboratorRoutes } from "./world-collaborators.js";
import { worldVersionRoutes } from "./world-versions.js";
import { assetRoutes, pickableImageKey } from "./assets.js";
import { sessionRoutes } from "./sessions.js";
import { messageRoutes } from "./messages.js";

before(async () => { await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href); });

// Run only through scripts/test-local.mjs (isolated in-memory database).
// The routes are mounted without their session check; `x-test-user` says who calls.
type Method = "GET" | "POST" | "PATCH" | "DELETE";
function mount(routes: Hono<AppEnv>, list: Array<[Method, string]>) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => c.text(String((err as Error).stack ?? err).slice(0, 600), 500));
  app.use("*", async (c, next) => {
    const id = c.req.header("x-test-user")!;
    const [row] = await db.select({ id: user.id, name: user.name, role: user.role, skipReview: user.skipReview }).from(user).where(eq(user.id, id));
    c.set("user", { ...row, image: null } as unknown as AppEnv["Variables"]["user"]);
    await next();
  });
  for (const [method, path] of list) {
    const handlers = routes.routes.filter((r) => r.method === method && r.path === path && r.handler !== authMiddleware)
      .map((r) => r.handler as Handler<AppEnv>);
    assert.ok(handlers.length, `${method} ${path}`);
    app.on(method, path, ...(handlers as [Handler<AppEnv>]));
  }
  return (who: string, method: Method, path: string, body?: unknown) => app.request(path, {
    method, headers: { "x-test-user": who, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const collab = mount(worldCollaboratorRoutes, [
  ["GET", "/worlds/:worldId"], ["POST", "/worlds/:worldId/invite"], ["PATCH", "/worlds/:worldId/:userId"],
  ["DELETE", "/worlds/:worldId/:userId"], ["POST", "/invites/:worldId/:answer{accept|decline}"],
]);

async function people(...names: string[]) {
  const ids = names.map(() => crypto.randomUUID());
  await db.insert(user).values(ids.map((id, i) => ({ id, name: names[i]!, email: `${id}@test.local`, username: `u${id.slice(0, 8)}` })));
  return ids;
}

async function card(creatorId: string, opts: { status?: string; group?: string | null; language?: string } = {}) {
  const [w] = await db.insert(worlds).values({
    creatorId, name: "Card", status: opts.status ?? "draft", schema: {},
    languageGroupId: opts.group ?? null, language: opts.language ?? "en",
  }).returning();
  return w!.id;
}

const grant = (worldId: string, userId: string, role: "editor" | "viewer" = "editor", status = "accepted") =>
  db.insert(worldCollaborators).values({ worldId, userId, role, status, acceptedAt: status === "accepted" ? new Date() : null });

describe("collaborator grants across a card's languages", { concurrency: false }, () => {
  it("lists, re-roles and removes a person on every variant at once", async () => {
    const [creator, peer] = await people("Creator", "Peer");
    const group = crypto.randomUUID();
    const zh = await card(creator!, { group, language: "zh" });
    const en = await card(creator!, { group, language: "en" });
    await grant(zh, peer!);

    const listed = await (await collab(creator!, "GET", `/worlds/${en}`)).json() as { data: { collaborators: Array<{ userId: string }> } };
    assert.deepEqual(listed.data.collaborators.map((c) => c.userId), [peer], "the English card lists who the Chinese one invited");

    assert.equal((await collab(creator!, "PATCH", `/worlds/${en}/${peer}`, { role: "viewer" })).status, 200);
    assert.equal((await getWorldAccess(peer!, zh))?.role, "viewer", "a role change on one variant reaches the row on the other");

    // An older row on the second variant must not keep the stronger access alive.
    await grant(en, peer!, "editor");
    assert.equal((await getWorldAccess(peer!, zh))?.role, "editor");
    await collab(creator!, "PATCH", `/worlds/${zh}/${peer}`, { role: "viewer" });
    assert.equal((await getWorldAccess(peer!, en))?.role, "viewer");

    assert.equal((await collab(creator!, "DELETE", `/worlds/${en}/${peer}`)).status, 200);
    assert.equal(await getWorldAccess(peer!, zh), null);
    // Kept as 'removed' on every variant, so an invite link can't seat them again.
    assert.deepEqual((await db.select().from(worldCollaborators).where(eq(worldCollaborators.userId, peer!))).map((r) => r.status), ["removed", "removed"]);
  });

  it("counts the cap across variants and answers a duplicate invite without a 500", async () => {
    const [creator, ...others] = await people("Creator", ...Array.from({ length: 11 }, (_, i) => `P${i}`));
    const group = crypto.randomUUID();
    const zh = await card(creator!, { group, language: "zh" });
    const en = await card(creator!, { group, language: "en" });
    for (const [i, id] of others.slice(0, 10).entries()) await grant(i % 2 ? zh : en, id);
    const over = await collab(creator!, "POST", `/worlds/${zh}/invite`, { userId: others[10], role: "editor" });
    assert.equal(over.status, 409);
    assert.equal((await over.json() as { code: string }).code, "TOO_MANY");

    const [a, b] = await people("A", "B");
    const solo = await card(a!);
    const twice = await Promise.all([1, 2].map(() => collab(a!, "POST", `/worlds/${solo}/invite`, { userId: b, role: "editor" })));
    assert.ok(twice.every((r) => r.status < 500), twice.map((r) => r.status).join(","));
    assert.equal((await db.select().from(worldCollaborators).where(eq(worldCollaborators.worldId, solo))).length, 1);
  });

  it("accepting the invite on one variant opens the card in every language", async () => {
    const [creator, peer] = await people("Creator", "Peer");
    const group = crypto.randomUUID();
    const zh = await card(creator!, { group, language: "zh" });
    const en = await card(creator!, { group, language: "en" });
    assert.equal((await collab(creator!, "POST", `/worlds/${zh}/invite`, { userId: peer, role: "editor" })).status, 201);
    assert.equal(await getWorldAccess(peer!, en), null, "pending grants nothing");
    assert.equal((await collab(peer!, "POST", `/invites/${zh}/accept`)).status, 200);
    assert.equal((await getWorldAccess(peer!, en))?.role, "editor");
  });
});

describe("what a collaborator can't take from the creator", { concurrency: false }, () => {
  const versions = mount(worldVersionRoutes, [["DELETE", "/:id/versions/:versionId"]]);
  const files = mount(assetRoutes, [["DELETE", "/worlds/:worldId/assets/:id"]]);

  it("deletes only their own named saves, and no card files", async () => {
    const [creator, editor] = await people("Creator", "Editor");
    const w = await card(creator!);
    await grant(w, editor!);
    const [theirs] = await db.insert(worldVersions).values({ worldId: w, createdBy: creator!, name: "Creator's", schema: {}, source: "manual" }).returning();
    const [mine] = await db.insert(worldVersions).values({ worldId: w, createdBy: creator!, actorId: editor!, name: "Mine", schema: {}, source: "manual" }).returning();
    assert.equal((await versions(editor!, "DELETE", `/${w}/versions/${theirs!.id}`)).status, 404);
    assert.equal((await versions(editor!, "DELETE", `/${w}/versions/${mine!.id}`)).status, 200);
    assert.equal((await versions(creator!, "DELETE", `/${w}/versions/${theirs!.id}`)).status, 200);

    const [file] = await db.insert(assets).values({ worldId: w, type: "image", filename: "a.png", url: `worlds/${w}/a.png` }).returning();
    assert.equal((await files(editor!, "DELETE", `/worlds/${w}/assets/${file!.id}`)).status, 403);
    assert.equal((await db.select().from(assets).where(eq(assets.id, file!.id))).length, 1);
  });

  it("covers and gallery pick only from this card, your own or public library, or the card's bound folders", async () => {
    const [creator, editor, stranger] = await people("Creator", "Editor", "Stranger");
    const w = await card(creator!);
    const other = await card(stranger!);
    await grant(w, editor!);
    const [bound] = await db.insert(assetFolders).values({ userId: creator!, name: "Card art" }).returning();
    const [hidden] = await db.insert(assetFolders).values({ userId: creator!, name: "Private" }).returning();
    await db.insert(worldFolderBindings).values({ worldId: w, folderId: bound!.id });
    const img = (userId: string, name: string, extra: Partial<typeof userAssets.$inferInsert> = {}) =>
      db.insert(userAssets).values({ userId, type: "image", filename: name, url: `users/${userId}/${name}`, ...extra }).returning().then((r) => r[0]!.id);
    const own = await img(editor!, "own.png");
    const shared = await img(creator!, "bound.png", { folderId: bound!.id });
    const privateArt = await img(creator!, "private.png", { folderId: hidden!.id });
    const strangers = await img(stranger!, "theirs.png");
    const published = await img(stranger!, "public.png", { isPublic: true });
    const [otherCardFile] = await db.insert(assets).values({ worldId: other, type: "image", filename: "x.png", url: `worlds/${other}/x.png` }).returning();
    const [thisCardFile] = await db.insert(assets).values({ worldId: w, type: "image", filename: "y.png", url: `worlds/${w}/y.png` }).returning();

    const access = (await getWorldAccess(editor!, w))!;
    const ok = async (id: string) => "key" in await pickableImageKey(id, w, editor!, access);
    assert.deepEqual(
      await Promise.all([own, shared, published, thisCardFile!.id, privateArt, strangers, otherCardFile!.id].map(ok)),
      [true, true, true, true, false, false, false],
    );
  });

  it("a collaborator's submission doesn't ride the creator's skip-review", async () => {
    const [creator, editor] = await people("Creator", "Editor");
    await db.update(user).set({ skipReview: true }).where(eq(user.id, creator!));
    const w = await card(creator!, { status: "published" });
    await grant(w, editor!);
    await db.update(worldCollaborators).set({ canPublish: true }).where(eq(worldCollaborators.userId, editor!));
    await db.insert(worldPendingEdits).values({ worldId: w, createdBy: creator!, groupKey: w, schema: { entries: [{ id: "x" }] }, reasons: ["entries"], status: "draft" });
    const res = await submitPendingEdit({ worldId: w, creatorId: creator!, actorId: editor! });
    assert.deepEqual(res, { ok: true, autoApproved: false });
    const [held] = await db.select({ status: worldPendingEdits.status }).from(worldPendingEdits).where(eq(worldPendingEdits.worldId, w));
    assert.equal(held!.status, "pending", "queued for an admin instead of going live");
  });
});

describe("a removed collaborator's old playtest", { concurrency: false }, () => {
  const sessions = mount(sessionRoutes, [["GET", "/:id"]]);
  const play = mount(messageRoutes, [["POST", "/sessions/:sessionId/messages"]]);

  it("stops showing or playing the draft once access ends", async () => {
    const [creator, peer] = await people("Creator", "Peer");
    const w = await card(creator!);
    const schema = migrateWorldDefinition({ id: w, version: "19.0.0", name: "Card", description: "", author: "test",
      entries: [{ id: "secret", name: "Secret", content: "draft only", keywords: [], enabled: true }], variables: [], rules: [], reactions: [],
      components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1, playerName: "User" } } as unknown as WorldDefinition);
    await db.update(worlds).set({ schema: schema as unknown as Record<string, unknown> }).where(eq(worlds.id, w));
    await grant(w, peer!);
    const [session] = await db.insert(playSessions).values({ userId: peer!, worldId: w }).returning();
    const first = await sessions(peer!, "GET", `/${session!.id}`);
    assert.equal(first.status, 200, await first.clone().text());

    await db.delete(worldCollaborators).where(and(eq(worldCollaborators.worldId, w), eq(worldCollaborators.userId, peer!)));
    const read = await sessions(peer!, "GET", `/${session!.id}`);
    assert.equal(read.status, 403);
    assert.ok(!(await read.text()).includes("draft only"));
    const send = await play(peer!, "POST", `/sessions/${session!.id}/messages`, { content: "hi" });
    assert.equal(send.status, 403);
    assert.equal((await send.json() as { code: string }).code, "WORLD_ACCESS_ENDED");
  });
});

describe("live cursors", { concurrency: false }, () => {
  const live = mount(worldCollaboratorRoutes, [["POST", "/worlds/:worldId/cursor"]]);
  it("fans a member's pointer out on the card's stream, and nobody else's", async () => {
    const { subscribeWorldEvents } = await import("../lib/world-events.js");
    const [creator, peer, stranger] = await people("Creator", "Peer", "Stranger");
    const w = await card(creator!);
    await grant(w, peer!);
    const heard: Array<Record<string, unknown>> = [];
    const stop = subscribeWorldEvents(w, (e) => { if (e.kind === "cursor") heard.push(e as unknown as Record<string, unknown>); });
    try {
      assert.equal((await live(stranger!, "POST", `/worlds/${w}/cursor`, { clientId: "s", x: 1, y: 2 })).status, 404);
      assert.equal((await live(peer!, "POST", `/worlds/${w}/cursor`, { clientId: "p", x: 10.5, y: -4, sel: "entry:e1", view: { x: 100, y: 50, zoom: 0.8 } })).status, 204);
      // Faster than the stream carries: dropped, not queued.
      assert.equal((await live(peer!, "POST", `/worlds/${w}/cursor`, { clientId: "p", x: 11, y: -4 })).status, 204);
      assert.equal(heard.length, 1);
      assert.deepEqual({ ...heard[0], at: undefined }, {
        kind: "cursor", userId: peer, name: "Peer", clientId: "p", x: 10.5, y: -4, sel: "entry:e1",
        view: { x: 100, y: 50, zoom: 0.8 }, at: undefined,
      });
      // Junk numbers never reach anyone.
      await new Promise((r) => setTimeout(r, 60));
      await live(peer!, "POST", `/worlds/${w}/cursor`, { clientId: "p", x: "1e400", y: Infinity, view: { x: 1, y: 1, zoom: 0 } });
      assert.equal(heard.at(-1)!.x, undefined);
      assert.equal(heard.at(-1)!.view, undefined);
    } finally { stop(); }
  });
});
