import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { MAX_WORLD_UPDATE_CONTENT, MAX_WORLD_UPDATE_TITLE } from "@yumina/shared";
import * as schema from "../db/schema.js";
import type { AppEnv, SessionUser } from "../lib/types.js";
import { createWorldUpdateEditRoutes } from "./world-update-edits.js";

test("published update corrections enforce ownership and change only authored text", async (t) => {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE worlds (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, status TEXT, updated_at TIMESTAMP);
      CREATE TABLE world_updates (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
        title TEXT NOT NULL, content TEXT, is_major BOOLEAN, created_at TIMESTAMP NOT NULL
      );
      CREATE TABLE world_pending_edits (world_id TEXT PRIMARY KEY);
      CREATE TABLE notifications (id TEXT PRIMARY KEY, payload JSONB);
      INSERT INTO worlds VALUES
        ('world', 'author', 'published', '2026-09-06 02:22:00'),
        ('sibling', 'author', 'unpublished', '2026-09-06 02:22:00'),
        ('other-world', 'other', 'published', '2026-09-06 02:22:00');
      INSERT INTO world_updates VALUES
        ('note', 'world', 'Original typo', 'Original details', true, '2026-09-06 02:22:00'),
        ('legacy-note', 'sibling', 'Old typo', null, null, '2026-09-01 00:00:00'),
        ('other-note', 'other-world', 'Other author', null, false, '2026-09-01 00:00:00');
      INSERT INTO world_pending_edits VALUES ('world');
      INSERT INTO notifications VALUES ('original-notification', '{"updateId":"note","title":"Original typo"}');
    `);
    const database = drizzle(client, { schema });
    const auth = createMiddleware<AppEnv>(async (c, next) => {
      const id = c.req.header("X-Test-User");
      if (!id) return c.json({ error: "Unauthorized" }, 401);
      c.set("user", { id, name: "Author name", role: id === "admin" ? "admin" : "user" } as SessionUser);
      await next();
    });
    let limitedRequests = 0;
    const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
      limitedRequests++;
      if (c.req.header("X-Test-Limit")) return c.json({ error: "Too many requests" }, 429);
      await next();
    });
    const app = new Hono<AppEnv>();
    app.route("/api/worlds", createWorldUpdateEditRoutes(database, auth, rateLimit));
    const call = (worldId: string, updateId: string, body: unknown, actor = "author", extraHeaders = {}) => app.request(
      `/api/worlds/${worldId}/updates/${updateId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(actor ? { "X-Test-User": actor } : {}), ...extraHeaders },
        body: JSON.stringify(body),
      },
    );
    const originalRows = await database.select().from(schema.worldUpdates).orderBy(schema.worldUpdates.id);
    const originalWorlds = (await client.query("SELECT * FROM worlds ORDER BY id")).rows;
    const originalNotifications = (await client.query("SELECT * FROM notifications ORDER BY id")).rows;
    const noteBefore = originalRows.find((row) => row.id === "note")!;

    await t.test("guests, other authors, administrators and mismatched source worlds cannot edit", async () => {
      assert.equal((await call("world", "note", { title: "No" }, "")).status, 401);
      for (const actor of ["other", "admin"]) {
        assert.equal((await call("world", "note", { title: "No" }, actor)).status, 404);
      }
      for (const [worldId, updateId] of [
        ["sibling", "note"], ["world", "legacy-note"], ["world", "other-note"],
        ["other-world", "other-note"], ["world", "missing"], ["missing", "note"],
      ]) {
        assert.equal((await call(worldId!, updateId!, { title: "No" })).status, 404);
      }
      assert.deepEqual(await database.select().from(schema.worldUpdates).orderBy(schema.worldUpdates.id), originalRows);
    });

    await t.test("invalid input and rate limits leave the original record intact", async () => {
      for (const body of [
        null, [], "text", {}, { title: "   " }, { title: 123 },
        { title: "x".repeat(MAX_WORLD_UPDATE_TITLE + 1) },
        { title: "Fine", content: "x".repeat(MAX_WORLD_UPDATE_CONTENT + 1) },
        { title: "Fine", content: 42 },
      ]) {
        assert.equal((await call("world", "note", body)).status, 400);
      }
      const malformed = await app.request("/api/worlds/world/updates/note", {
        method: "PATCH", headers: { "Content-Type": "application/json", "X-Test-User": "author" }, body: "{",
      });
      assert.equal(malformed.status, 400);
      assert.equal((await call("world", "note", { title: "Fine" }, "author", { "X-Test-Limit": "1" })).status, 429);
      assert.ok(limitedRequests > 0);
      assert.deepEqual(await database.select().from(schema.worldUpdates).orderBy(schema.worldUpdates.id), originalRows);
    });

    await t.test("the owner can correct a published note while a separate world edit awaits review", async () => {
      const response = await call("world", "note", {
        title: "  Corrected title  ", content: "  Corrected details  ",
        isMajor: false, worldId: "other-world", createdAt: "2099-01-01T00:00:00.000Z", id: "replacement",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        data: {
          id: "note", worldId: "world", title: "Corrected title", content: "Corrected details",
          isMajor: true, createdAt: noteBefore.createdAt.toISOString(), creatorName: "Author name",
        },
      });
      const [saved] = await database.select().from(schema.worldUpdates).where(eq(schema.worldUpdates.id, "note"));
      assert.deepEqual(saved, { ...noteBefore, title: "Corrected title", content: "Corrected details" });
    });

    await t.test("empty optional details and legacy nullable fields remain supported", async () => {
      const response = await call("world", "note", { title: "Corrected title", content: "  " });
      assert.equal(response.status, 200);
      const [saved] = await database.select().from(schema.worldUpdates).where(eq(schema.worldUpdates.id, "note"));
      assert.equal(saved?.content, null);
      assert.equal(saved?.isMajor, true);
      assert.equal((await call("world", "note", {
        title: "Corrected title", content: null, isMajor: "not an editable field",
      })).status, 200);
      assert.equal((await call("sibling", "legacy-note", { title: "Legacy correction" })).status, 200);
      const [legacy] = await database.select().from(schema.worldUpdates).where(eq(schema.worldUpdates.id, "legacy-note"));
      assert.deepEqual(legacy, { ...originalRows.find((row) => row.id === "legacy-note"), title: "Legacy correction" });
    });

    await t.test("corrections retain history order and do not publish, notify or bump the work", async () => {
      const rows = await database.select().from(schema.worldUpdates).orderBy(schema.worldUpdates.id);
      assert.deepEqual(rows.map(({ id, worldId, isMajor, createdAt }) => ({ id, worldId, isMajor, createdAt })),
        originalRows.map(({ id, worldId, isMajor, createdAt }) => ({ id, worldId, isMajor, createdAt })));
      assert.deepEqual((await client.query("SELECT * FROM worlds ORDER BY id")).rows, originalWorlds);
      assert.deepEqual((await client.query("SELECT * FROM notifications ORDER BY id")).rows, originalNotifications);
      assert.deepEqual((await client.query("SELECT world_id FROM world_pending_edits")).rows, [{ world_id: "world" }]);
    });
  } finally {
    await client.close();
  }
});
