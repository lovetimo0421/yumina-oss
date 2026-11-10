import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema.js";
import type { AppEnv, SessionUser } from "../lib/types.js";
import { createWorldUnpublishRoutes } from "./world-unpublish.js";

test("unpublishing variants enforces the reviewed selection atomically", async (t) => {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE worlds (
        id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, name TEXT NOT NULL,
        language TEXT, language_group_id TEXT, variant_label TEXT, status TEXT NOT NULL,
        is_published BOOLEAN, thumbnail_url TEXT, updated_at TIMESTAMP, created_at TIMESTAMP
      );
      CREATE TABLE user_library (world_id TEXT NOT NULL, user_id TEXT NOT NULL);
      INSERT INTO worlds VALUES
        ('zh', 'author', '中文', 'zh', 'group', null, 'published', true, null, '2026-10-01', '2026-10-01'),
        ('en', 'author', 'English', 'en', 'group', null, 'published', true, 'cover', '2026-10-01', '2026-10-01'),
        ('en-alt', 'author', 'English alternate', 'en', 'group', 'Alternate', 'published', true, null, '2026-10-01', '2026-10-01'),
        ('ja', 'author', '日本語', 'ja', 'group', null, 'unpublished', false, null, '2026-10-01', '2026-10-01'),
        ('draft', 'author', 'Draft', 'zh', 'group', 'Test', 'draft', false, null, '2026-10-01', '2026-10-01'),
        ('review', 'author', 'Review', 'es', 'group', null, 'pending_review', false, null, '2026-10-01', '2026-10-01'),
        ('other-group', 'author', 'Other group', 'en', 'elsewhere', null, 'published', true, null, '2026-10-01', '2026-10-01'),
        ('foreign', 'other', 'Someone else', 'en', 'group', null, 'published', true, null, '2026-10-01', '2026-10-01'),
        ('solo', 'author', 'Standalone', null, null, null, 'published', true, null, '2026-10-01', '2026-10-01'),
        ('solo-other', 'author', 'Other standalone', null, null, null, 'published', true, null, '2026-10-01', '2026-10-01');
      INSERT INTO user_library VALUES ('en', 'reader-en'), ('en-alt', 'reader-alt'), ('zh', 'reader-zh'), ('ja', 'reader-ja');
    `);
    const database = drizzle(client, { schema });
    const auth = createMiddleware<AppEnv>(async (c, next) => {
      const id = c.req.header("X-Test-User");
      if (!id) return c.json({ error: "Unauthorized" }, 401);
      c.set("user", { id } as SessionUser);
      await next();
    });
    const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
      if (c.req.header("X-Test-Limit")) return c.json({ error: "Limited" }, 429);
      await next();
    });
    const notices: { recipients: string[]; worldId: string; actor: string }[] = [];
    const flagged = new Set<string>();
    let failNotifications = false;
    const app = new Hono<AppEnv>();
    app.onError((_error, c) => c.json({ error: "Test database failure" }, 500));
    app.route("/api/worlds", createWorldUnpublishRoutes(database, auth, rateLimit, {
      flagWrite: (id) => { flagged.add(id); },
      notify: async (recipients, payload, actor) => {
        if (failNotifications) throw new Error("Test notification outage");
        notices.push({ recipients, worldId: payload.worldId, actor });
      },
    }));
    const get = (worldId = "zh", actor = "author") => app.request(`/api/worlds/${worldId}/unpublish`, { headers: actor ? { "X-Test-User": actor } : {} });
    const post = (worldIds: unknown, worldId = "zh", actor = "author", extraHeaders = {}) => app.request(`/api/worlds/${worldId}/unpublish`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(actor ? { "X-Test-User": actor } : {}), ...extraHeaders }, body: JSON.stringify({ worldIds }),
    });
    const snapshot = async () => (await client.query<{ id: string; status: string; is_published: boolean }>("SELECT * FROM worlds ORDER BY id")).rows;
    const reset = async () => {
      await client.exec("UPDATE worlds SET status='published', is_published=true, updated_at='2026-10-01' WHERE id IN ('zh','en','en-alt','solo');");
      notices.length = 0; flagged.clear();
    };

    await t.test("the owner sees all owned siblings, including same-language and inactive variants", async () => {
      assert.equal((await get("zh", "")).status, 401);
      assert.equal((await get("zh", "other")).status, 404);
      assert.equal((await get("missing")).status, 404);
      const response = await get();
      assert.equal(response.status, 200);
      const { data } = await response.json() as { data: { id: string; language: string | null }[] };
      assert.deepEqual(data.map((row: { id: string }) => row.id).sort(), ["draft", "en", "en-alt", "ja", "review", "zh"]);
      assert.equal(data.filter((row) => row.language === "en").length, 2);
      assert.equal((await (await get("solo")).json() as { data: unknown[] }).data.length, 1);
    });

    await t.test("malformed, duplicate, unauthorized, unrelated and stale selections never partially apply", async () => {
      const before = await snapshot();
      for (const ids of [null, [], ["en", "en"], [2], "en", [""], Array.from({ length: 1001 }, (_, i) => String(i))]) {
        assert.equal((await post(ids)).status, 400);
      }
      for (const id of ["missing", "foreign", "other-group", "solo"]) {
        assert.equal((await post(["en", id])).status, 404);
      }
      for (const id of ["ja", "draft", "review"]) assert.equal((await post(["en", id])).status, 409);
      assert.equal((await post(["en"], "zh", "")).status, 401);
      assert.equal((await post(["en"], "zh", "other")).status, 404);
      assert.equal((await post(["solo-other"], "solo")).status, 404);
      assert.equal((await post(["en"], "zh", "author", { "X-Test-Limit": "1" })).status, 429);
      const malformed = await app.request("/api/worlds/zh/unpublish", { method: "POST", headers: { "X-Test-User": "author", "Content-Type": "application/json" }, body: "{" });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await snapshot(), before);
      assert.equal(notices.length, 0);
      assert.equal(flagged.size, 0);
    });

    await t.test("custom selection can omit the current version and notifies only selected readers", async () => {
      const before = await snapshot();
      const response = await post(["en-alt", "en"]);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as { data: { worldIds: string[] } }).data.worldIds.sort(), ["en", "en-alt"]);
      const after = await snapshot();
      for (const row of after) {
        if (row.id === "en" || row.id === "en-alt") {
          assert.equal(row.status, "unpublished"); assert.equal(row.is_published, false);
        } else assert.deepEqual(row, before.find((old) => old.id === row.id));
      }
      assert.deepEqual(notices.sort((a, b) => a.worldId.localeCompare(b.worldId)), [
        { recipients: ["reader-en"], worldId: "en", actor: "author" },
        { recipients: ["reader-alt"], worldId: "en-alt", actor: "author" },
      ]);
      assert.deepEqual([...flagged].sort(), ["author", "reader-alt", "reader-en"]);
      assert.equal((await post(["en-alt", "en"])).status, 409);
      assert.equal(notices.length, 2, "a retry must not notify again");
    });

    await t.test("only current and all published are exact ID selections, never language-wide or group-wide shortcuts", async () => {
      await reset();
      assert.equal((await post(["zh"])).status, 200);
      let rows = await snapshot();
      assert.equal(rows.find((row) => row.id === "en")?.status, "published");
      // An already-down current row can still manage its published siblings.
      assert.equal((await post(["en", "en-alt"], "zh")).status, 200);
      rows = await snapshot();
      assert.ok(rows.filter((row) => ["zh", "en", "en-alt"].includes(String(row.id))).every((row) => row.status === "unpublished"));
      assert.equal(rows.find((row) => row.id === "foreign")?.status, "published");
      assert.equal(rows.find((row) => row.id === "draft")?.status, "draft");
      await reset();
      assert.equal((await post(["solo"], "solo")).status, 200);
      assert.equal((await snapshot()).find((row) => row.id === "solo-other")?.status, "published");
    });

    await t.test("a database failure rolls back the entire batch without emitting notifications", async () => {
      await reset();
      await client.exec(`CREATE FUNCTION reject_test_unpublish() RETURNS trigger AS $$ BEGIN
        IF NEW.id = 'en-alt' THEN RAISE EXCEPTION 'Test write failure'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_unpublish BEFORE UPDATE ON worlds FOR EACH ROW EXECUTE FUNCTION reject_test_unpublish();`);
      const before = await snapshot();
      assert.equal((await post(["en", "en-alt"])).status, 500);
      assert.deepEqual(await snapshot(), before);
      assert.equal(notices.length, 0);
      assert.equal(flagged.size, 0);
      await client.exec("DROP TRIGGER reject_test_unpublish ON worlds; DROP FUNCTION reject_test_unpublish();");
    });

    await t.test("a notification failure cannot misreport a committed unpublish as failed", async () => {
      failNotifications = true;
      const errors: unknown[][] = [];
      const original = console.error;
      console.error = (...args) => { errors.push(args); };
      try {
        assert.equal((await post(["en"])).status, 200);
        assert.equal((await snapshot()).find((row) => row.id === "en")?.status, "unpublished");
        assert.equal(errors.length, 1);
      } finally { console.error = original; }
    });
  } finally {
    await client.close();
  }
});
