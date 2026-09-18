import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { transform } from "sucrase";
import { MAX_WORLD_UPDATE_CONTENT, MAX_WORLD_UPDATE_TITLE } from "@yumina/shared";
import * as schema from "../db/schema.js";
import type { AppEnv, SessionUser } from "../lib/types.js";
import { parseWorldUpdateNoteBody } from "../lib/world-update-note.js";

test("independent update creation keeps author, lifecycle, and notification boundaries", async (t) => {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE worlds (
        id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        is_published BOOLEAN NOT NULL DEFAULT false, schema JSONB NOT NULL DEFAULT '{"firstMessage":"Original story"}',
        updated_at TIMESTAMP NOT NULL DEFAULT '2026-09-06 02:22:00'
      );
      CREATE TABLE world_pending_edits (
        world_id TEXT PRIMARY KEY REFERENCES worlds(id), status TEXT NOT NULL, update_title TEXT
      );
      CREATE TABLE world_updates (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), title TEXT NOT NULL,
        content TEXT, is_major BOOLEAN DEFAULT false, created_at TIMESTAMP NOT NULL DEFAULT now()
      );
      CREATE TABLE user_library (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, user_id TEXT NOT NULL);
      INSERT INTO worlds (id, creator_id, name, status, is_published) VALUES
        ('live', 'author', 'Live work', 'published', true),
        ('draft', 'author', 'Draft work', 'draft', false),
        ('unpublished', 'author', 'Unpublished work', 'unpublished', false),
        ('rejected', 'author', 'Rejected work', 'rejected', false),
        ('in-review', 'author', 'In review', 'pending_review', false),
        ('unknown', 'author', 'Unknown state', 'archived', false),
        ('held-draft', 'author', 'Held draft', 'published', true),
        ('held-pending', 'author', 'Held pending', 'published', true),
        ('held-rejected', 'author', 'Held rejected', 'published', true),
        ('held-unpublished', 'author', 'Held unpublished', 'unpublished', false),
        ('other', 'other-author', 'Other work', 'published', true);
      INSERT INTO world_pending_edits VALUES
        ('held-draft', 'draft', 'Queued note'), ('held-pending', 'pending', 'Submitted note'),
        ('held-rejected', 'rejected', 'Rejected note'), ('held-unpublished', 'draft', 'Private note');
      INSERT INTO user_library VALUES
        ('reader-one', 'live', 'reader-a'), ('reader-two', 'live', 'reader-b'),
        ('author-own', 'live', 'author'), ('other-reader', 'other', 'reader-c');
    `);
    const originalWorlds = (await client.query("SELECT * FROM worlds ORDER BY id")).rows;
    const originalHeldEdits = (await client.query("SELECT * FROM world_pending_edits ORDER BY world_id")).rows;
    const queries: string[] = [];
    const db = drizzle(client, { schema, logger: { logQuery: (query) => { queries.push(query); } } });
    const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
      const id = c.req.header("X-Test-User");
      if (!id) return c.json({ error: "Unauthorized" }, 401);
      c.set("user", { id, name: id, role: id === "admin" ? "admin" : "user" } as SessionUser);
      await next();
    });
    let limitedRequests = 0;
    const rateLimitMiddleware = (bucket: string) => {
      assert.equal(bucket, "content-creation");
      return createMiddleware<AppEnv>(async (c, next) => {
        limitedRequests += 1;
        if (c.req.header("X-Test-Limit")) return c.json({ error: "Too many requests" }, 429);
        await next();
      });
    };
    const notifications: Array<{ userIds: string[]; type: string; payload: Record<string, unknown>; options: unknown }> = [];
    let failNotifications = false;
    let loggedFailures = 0;
    const notifyMany = async (userIds: string[], type: string, payload: Record<string, unknown>, options: unknown) => {
      notifications.push({ userIds, type, payload, options });
      if (failNotifications) throw new Error("Notification service unavailable");
    };
    const worldRoutes = new Hono<AppEnv>();
    // Load the production handler with isolated dependencies, avoiding startup
    // of the production database, Redis, or unrelated route side effects.
    const source = readFileSync(new URL("./worlds.ts", import.meta.url), "utf8");
    const routeStart = source.indexOf('worldRoutes.post("/:id/updates",');
    const routeEnd = source.indexOf('worldRoutes.route("/", createWorldUpdateEditRoutes', routeStart);
    assert.ok(routeStart >= 0 && routeEnd > routeStart);
    const route = transform(source.slice(routeStart, routeEnd), { transforms: ["typescript"] }).code;
    const dependencies = {
      worldRoutes, authMiddleware, rateLimitMiddleware, parseWorldUpdateNoteBody, db, and, eq, notifyMany,
      worlds: schema.worlds, worldPendingEdits: schema.worldPendingEdits,
      worldUpdates: schema.worldUpdates, userLibrary: schema.userLibrary,
      console: { error: () => { loggedFailures += 1; } },
    };
    new Function(...Object.keys(dependencies), route)(...Object.values(dependencies));
    const call = (worldId: string, body: unknown, actor = "author", extraHeaders = {}) => worldRoutes.request(
      `/${worldId}/updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(actor ? { "X-Test-User": actor } : {}), ...extraHeaders },
        body: JSON.stringify(body),
      },
    );
    const allRecords = async () => (await client.query("SELECT * FROM world_updates ORDER BY id")).rows;

    await t.test("authentication, ownership, and rate limits prevent insertion", async () => {
      const body = { title: "No permission", notifyPlayers: false };
      assert.equal((await call("live", body, "")).status, 401);
      for (const actor of ["reader-a", "other-author", "admin"]) {
        assert.equal((await call("live", body, actor)).status, 404, actor);
      }
      assert.equal((await call("other", body)).status, 404);
      assert.equal((await call("missing", body)).status, 404);
      assert.equal((await call("live", body, "author", { "X-Test-Limit": "1" })).status, 429);
      assert.ok(limitedRequests > 0);
      assert.deepEqual(await allRecords(), []);
      assert.equal(notifications.length, 0);
    });

    await t.test("invalid inputs and non-boolean notification choices cannot create records", async () => {
      for (const notifyPlayers of [null, "false", "true", 0, 1, [], {}]) {
        assert.equal((await call("live", { title: "Invalid choice", notifyPlayers })).status, 400);
      }
      for (const body of [
        null, [], {}, { title: " " }, { title: 123 },
        { title: "x".repeat(MAX_WORLD_UPDATE_TITLE + 1) },
        { title: "Title", content: "x".repeat(MAX_WORLD_UPDATE_CONTENT + 1) },
        { title: "Title", content: 4 }, { title: "Title", isMajor: "yes" },
      ]) assert.equal((await call("live", body)).status, 400);
      const malformed = await worldRoutes.request("/live/updates", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "author" }, body: "{",
      });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await allRecords(), []);
      assert.equal(notifications.length, 0);
    });

    await t.test("a quiet live record skips both recipient lookup and notification fanout", async () => {
      queries.length = 0;
      const response = await call("live", {
        title: "  Quiet correction  ", content: "  More details  ", isMajor: true, notifyPlayers: false,
        worldId: "other", id: "client-id", createdAt: "2099-01-01T00:00:00.000Z", status: "draft",
      });
      assert.equal(response.status, 201);
      const { data } = await response.json() as { data: { id: string; worldId: string; title: string; content: string; isMajor: boolean; createdAt: string } };
      assert.equal(data.worldId, "live");
      assert.equal(data.title, "Quiet correction");
      assert.equal(data.content, "More details");
      assert.equal(data.isMajor, true);
      assert.notEqual(data.id, "client-id");
      assert.notEqual(data.createdAt, "2099-01-01T00:00:00.000Z");
      assert.equal(notifications.length, 0);
      assert.equal(queries.some((query) => query.includes('from "user_library"')), false);
      assert.ok(queries.some((query) => query.includes('from "worlds"') && query.includes("for update")));
    });

    await t.test("saved draft, unpublished, and rejected worlds allow only explicitly quiet records", async () => {
      for (const worldId of ["draft", "unpublished", "rejected"]) {
        const response = await call(worldId, { title: `Note for ${worldId}`, notifyPlayers: false });
        assert.equal(response.status, 201, worldId);
        const { data } = await response.json() as { data: { worldId: string; content: null; isMajor: boolean } };
        assert.equal(data.worldId, worldId);
        assert.equal(data.content, null);
        assert.equal(data.isMajor, false);
        const beforeRejected = await allRecords();
        for (const body of [{ title: "Legacy notify" }, { title: "Explicit notify", notifyPlayers: true }]) {
          const denied = await call(worldId, body);
          assert.equal(denied.status, 400, worldId);
          assert.equal((await denied.json() as { code: string }).code, "WORLD_UPDATE_NOTIFY_UNAVAILABLE");
        }
        assert.deepEqual(await allRecords(), beforeRejected);
      }
      assert.equal(notifications.length, 0);
    });

    await t.test("initial review and unknown world states reject even quiet records", async () => {
      const before = await allRecords();
      for (const worldId of ["in-review", "unknown"]) {
        for (const notifyPlayers of [false, true]) {
          const response = await call(worldId, { title: "Not allowed", notifyPlayers });
          assert.equal(response.status, 409, worldId);
          assert.equal((await response.json() as { code: string }).code, "WORLD_UPDATE_UNAVAILABLE");
        }
      }
      assert.deepEqual(await allRecords(), before);
      assert.equal(notifications.length, 0);
    });

    await t.test("every held-edit state prevents immediate records, including quiet ones", async () => {
      const before = await allRecords();
      for (const worldId of ["held-draft", "held-pending", "held-rejected", "held-unpublished"]) {
        for (const body of [{ title: "Legacy" }, { title: "Quiet", notifyPlayers: false }, { title: "Notify", notifyPlayers: true }]) {
          const response = await call(worldId, body);
          assert.equal(response.status, 409, worldId);
          assert.equal((await response.json() as { code: string }).code, "WORLD_EDIT_PENDING");
        }
      }
      assert.deepEqual(await allRecords(), before);
      assert.equal(notifications.length, 0);
    });

    await t.test("explicit notification and legacy omission retain live-world recipient behavior", async () => {
      for (const body of [{ title: "Explicit notice", notifyPlayers: true }, { title: "Legacy notice" }]) {
        const before = notifications.length;
        const response = await call("live", body);
        assert.equal(response.status, 201);
        const { data } = await response.json() as { data: { id: string } };
        assert.equal(notifications.length, before + 1);
        const notice = notifications.at(-1)!;
        assert.deepEqual(notice.userIds.sort(), ["reader-a", "reader-b"]);
        assert.equal(notice.type, "world_update");
        assert.deepEqual(notice.payload, {
          worldId: "live", worldName: "Live work", updateId: data.id,
          title: body.title, isMajor: false, creatorUserId: "author",
        });
        assert.deepEqual(notice.options, { actorUserId: "author" });
      }
    });

    await t.test("a notification failure still returns the durable new record once", async () => {
      const before = (await allRecords()).length;
      failNotifications = true;
      const response = await call("live", { title: "Durable note", notifyPlayers: true });
      failNotifications = false;
      assert.equal(response.status, 201);
      assert.equal((await allRecords()).length, before + 1);
      assert.equal(loggedFailures, 1);
    });

    await t.test("creating records never publishes, saves, or changes held content", async () => {
      assert.deepEqual((await client.query("SELECT * FROM worlds ORDER BY id")).rows, originalWorlds);
      assert.deepEqual((await client.query("SELECT * FROM world_pending_edits ORDER BY world_id")).rows, originalHeldEdits);
    });
  } finally {
    await client.close();
  }
});
