import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, desc, eq, sql } from "drizzle-orm";
import { transform } from "sucrase";
import * as schema from "../db/schema.js";
import type { AppEnv, SessionUser } from "../lib/types.js";
import {
  canReadWorldUpdateHistory,
  hasMoreWorldUpdates,
  normalizeWorldUpdateOffset,
  WORLD_UPDATE_PAGE_SIZE,
} from "../lib/world-update-history.js";

test("history read access does not grant update-edit permission", async (t) => {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE worlds (
        id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, status TEXT NOT NULL,
        visibility TEXT NOT NULL, age_rating TEXT, language_group_id TEXT
      );
      CREATE TABLE follows (follower_id TEXT NOT NULL, following_id TEXT NOT NULL);
      CREATE TABLE world_updates (
        id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
        title TEXT NOT NULL, content TEXT, is_major BOOLEAN, created_at TIMESTAMP NOT NULL
      );
      INSERT INTO "user" VALUES ('author', 'Author');
      INSERT INTO worlds VALUES
        ('public', 'author', 'published', 'public', 'all', null),
        ('restricted', 'author', 'published', 'followers', 'all', null),
        ('unpublished', 'author', 'unpublished', 'public', 'all', null),
        ('empty-draft', 'author', 'draft', 'public', 'all', null);
      INSERT INTO follows VALUES ('follower', 'author');
      INSERT INTO world_updates VALUES
        ('public-note', 'public', 'Original typo', null, false, '2026-09-06 02:22:00'),
        ('restricted-note', 'restricted', 'Follower update', null, false, '2026-09-06 02:22:00'),
        ('old-note', 'unpublished', 'Old update', null, false, '2026-09-06 02:22:00');
    `);
    const database = drizzle(client, { schema });
    const optionalAuthMiddleware = createMiddleware<AppEnv>(async (c, next) => {
      const id = c.req.header("X-Test-User");
      if (id) c.set("user", { id, name: id, role: id === "admin" ? "admin" : "user" } as SessionUser);
      await next();
    });
    const worldRoutes = new Hono<AppEnv>();

    // Execute the real route against an isolated database without starting the
    // production database, Redis, or unrelated routes imported by worlds.ts.
    const source = readFileSync(new URL("./worlds.ts", import.meta.url), "utf8");
    const routeStart = source.indexOf('worldRoutes.get("/:id/updates",');
    const routeEnd = source.indexOf("// Content version history", routeStart);
    assert.ok(routeStart >= 0 && routeEnd > routeStart);
    const route = transform(source.slice(routeStart, routeEnd), { transforms: ["typescript"] }).code;
    const dependencies = {
      worldRoutes, optionalAuthMiddleware,
      readOwn: async () => database,
      readDb: async () => database,
      worlds: schema.worlds, follows: schema.follows, worldUpdates: schema.worldUpdates, user: schema.user,
      and, desc, eq, sql,
      canReadWorldUpdateHistory, hasMoreWorldUpdates, normalizeWorldUpdateOffset, WORLD_UPDATE_PAGE_SIZE,
    };
    new Function(...Object.keys(dependencies), route)(...Object.values(dependencies));

    const call = (worldId: string, actor?: string) => worldRoutes.request(`/${worldId}/updates`, {
      headers: actor ? { "X-Test-User": actor } : {},
    });

    await t.test("only the author receives edit permission, including unpublished and empty drafts", async () => {
      for (const worldId of ["public", "restricted", "unpublished", "empty-draft"]) {
        const response = await call(worldId, "author");
        assert.equal(response.status, 200, worldId);
        const body = await response.json() as { canEdit: boolean; data: unknown[] };
        assert.equal(body.canEdit, true, worldId);
        assert.equal(body.data.length, worldId === "empty-draft" ? 0 : 1, worldId);
        assert.equal(response.headers.get("Cache-Control"), "private, no-store");
        assert.equal(response.headers.get("Vary"), "Cookie");
      }
    });

    await t.test("guests, readers, followers, and admins can read allowed histories without edit permission", async () => {
      const cases: Array<[string, string | undefined]> = [
        ["public", undefined], ["public", "reader"], ["public", "follower"], ["public", "admin"],
        ["restricted", "follower"], ["restricted", "admin"], ["unpublished", "admin"],
      ];
      for (const [worldId, actor] of cases) {
        const response = await call(worldId, actor);
        assert.equal(response.status, 200, `${worldId}:${actor}`);
        const body = await response.json() as { canEdit: boolean; data: unknown[] };
        assert.equal(body.canEdit, false, `${worldId}:${actor}`);
        assert.equal(body.data.length, 1);
        if (actor) assert.equal(response.headers.get("Cache-Control"), "private, no-store");
        assert.equal(response.headers.get("Vary"), "Cookie");
      }
    });

    await t.test("unreadable and missing works still return no history or edit capability", async () => {
      const cases: Array<[string, string | undefined]> = [
        ["restricted", undefined], ["restricted", "reader"],
        ["unpublished", "reader"], ["unpublished", "follower"],
        ["empty-draft", "reader"], ["missing", "author"],
      ];
      for (const [worldId, actor] of cases) {
        const response = await call(worldId, actor);
        assert.equal(response.status, 404, `${worldId}:${actor}`);
        assert.deepEqual(await response.json(), { error: "World not found" });
      }
    });
  } finally {
    await client.close();
  }
});
