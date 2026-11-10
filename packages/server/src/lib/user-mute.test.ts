import "../utc-init.js";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { USER_MUTE_COLUMNS_SQL } from "../db/user-mute-schema.js";
import { setUserMute } from "./user-mute.js";
import { createAccountMuteMiddleware } from "../middleware/user-mute.js";
import type { AppEnv, SessionUser } from "./types.js";

test("admin mute persists, expires, changes duration and un-mutes with atomic audit", { skip: "Hosted moderation migration is not exported" }, async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE "user" (id text PRIMARY KEY, role text, updated_at timestamp);
      INSERT INTO "user" VALUES ('admin', 'admin', NOW()), ('target', 'user', NOW()), ('other-admin', 'admin', NOW());
      CREATE TABLE admin_actions (id text PRIMARY KEY, admin_id text, action_type text NOT NULL,
        target_type text NOT NULL, target_id text NOT NULL, metadata jsonb, created_at timestamp DEFAULT NOW());`);
    const deploymentDdl = readFileSync(new URL("../../drizzle/0054_user_mutes.sql", import.meta.url), "utf8");
    // Git may check out the .sql file with CRLF while the JS string uses LF.
    assert.equal(deploymentDdl.trim().replace(/;$/, "").replace(/\r\n/g, "\n"), USER_MUTE_COLUMNS_SQL.replace(/\r\n/g, "\n"));
    await pg.exec(deploymentDdl);
    await pg.exec(USER_MUTE_COLUMNS_SQL);
    const database = drizzle(pg) as unknown as Parameters<typeof setUserMute>[0];
    const now = new Date("2026-09-06T12:00:00Z");
    const state = async () => (await pg.query<{ is_muted: boolean; muted_until: Date | null }>(`SELECT is_muted, muted_until FROM "user" WHERE id = 'target'`)).rows[0]!;
    assert.equal((await state()).is_muted, false, "existing accounts default to unmuted");
    for (const [duration, days] of [["day", 1], ["week", 7], ["month", 30]] as const) {
      assert.equal(await setUserMute(database, "admin", "target", duration, now), "ok");
      assert.equal((await state()).is_muted, true);
      assert.equal((await state()).muted_until!.getTime(), now.getTime() + days * 86_400_000);
    }
    assert.equal(await setUserMute(database, "admin", "target", "permanent", now), "ok");
    assert.deepEqual(await state(), { is_muted: true, muted_until: null });
    assert.equal(await setUserMute(database, "admin", "target", null, now), "ok");
    assert.deepEqual(await state(), { is_muted: false, muted_until: null });
    const audit = await pg.query<{ action_type: string; metadata: { duration: string | null } }>("SELECT action_type, metadata FROM admin_actions");
    assert.equal(audit.rows.length, 5);
    assert.equal(audit.rows.at(-1)?.action_type, "user_unmute");
    assert.equal(audit.rows.at(-1)?.metadata.duration, null);

    for (const [actor, target, expected] of [
      ["target", "other-admin", "forbidden"], ["missing", "target", "forbidden"],
      ["admin", "admin", "self"], ["admin", "other-admin", "admin"], ["admin", "missing", "missing"],
    ] as const) {
      assert.equal(await setUserMute(database, actor, target, "day", now), expected);
    }
    assert.equal((await pg.query("SELECT * FROM admin_actions")).rows.length, 5);
    await pg.exec("ALTER TABLE admin_actions ADD CONSTRAINT reject_mutes CHECK (action_type <> 'user_mute') NOT VALID");
    await assert.rejects(setUserMute(database, "admin", "target", "day", now));
    assert.deepEqual(await state(), { is_muted: false, muted_until: null }, "failed audit rolls back the mute");
  } finally { await pg.close(); }
});

test("server guard denies timed/permanent writes and allows expired/unmuted users", async () => {
  const unmutedElsewhere = async () => null;
  for (const [isMuted, mutedUntil, status] of [
    [true, new Date(Date.now() + 60_000), 403], [true, null, 403],
    [true, new Date(Date.now() - 1), 200], [false, null, 200],
  ] as const) {
    let writes = 0;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("user", { isMuted, mutedUntil } as SessionUser); await next(); });
    app.post("/write", createAccountMuteMiddleware(unmutedElsewhere), (c) => { writes++; return c.json({ ok: true }); });
    const response = await app.request("/write", { method: "POST" });
    assert.equal(response.status, status);
    assert.equal(writes, status === 200 ? 1 : 0);
    if (status === 403) {
      const body = await response.json() as { code: string; mutedUntil: string | null };
      assert.equal(body.code, "USER_MUTED");
      assert.equal(body.mutedUntil, mutedUntil?.toISOString() ?? null);
    }
  }
});

test("the account guard also honours a community mute", async () => {
  // The two moderation screens write different stores. Before this, a mute
  // applied on the community screen left direct messages and wall posts open.
  const until = new Date(Date.now() + 60_000);
  let writes = 0;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: "target", isMuted: false, mutedUntil: null } as SessionUser); await next(); });
  app.post("/write", createAccountMuteMiddleware(async () => ({ expiresAt: until, revokedAt: null })), (c) => { writes++; return c.json({ ok: true }); });
  const response = await app.request("/write", { method: "POST" });
  assert.equal(response.status, 403);
  assert.equal(writes, 0);
  const body = await response.json() as { code: string; mutedUntil: string };
  assert.equal(body.code, "USER_MUTED");
  assert.equal(body.mutedUntil, until.toISOString());
});
