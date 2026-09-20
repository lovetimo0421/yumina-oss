import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { GameStateManager, type WorldDefinition } from "@yumina/engine";
import * as schema from "../db/schema.js";

// Explicit opt-in only. Every fixture and its mutations are rolled back;
// no existing user/card/session is read or changed. Never run on production.
test("State Update Guard PostgreSQL atomicity", { skip: process.env.STATE_GUARD_DB_TEST !== "1" }, async (t) => {
  const connectionString = process.env.DATABASE_URL;
  assert.ok(connectionString, "Pass the dedicated testing DATABASE_URL");
  // The injected DB is the ONLY database used. Keep imported service pools inert.
  process.env.DATABASE_URL = "postgres://unit@127.0.0.1:1/unit";
  process.env.DATABASE_READ_URL = "";
  process.env.REDIS_URL = "";
  process.env.POSTHOG_API_KEY = "";
  process.env.BETTER_AUTH_SECRET = "state-guard-pg-test";
  const { TurnOutputAttempt } = await import("./turn-output-validation.js");
  const pool = new pg.Pool({ connectionString, max: 1, statement_timeout: 10_000 });
  const database = drizzle(pool, { schema });
  t.after(() => pool.end());
  const world: WorldDefinition = {
    id: "fixture", version: "1.0.0", name: "Guard PG test", description: "", author: "test",
    entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: {},
    variables: [{ id: "hp", name: "health", type: "number", defaultValue: 100 }, { id: "ui", name: "panel", type: "string", defaultValue: "open" }],
  };
  const rollback = new Error("intentional fixture rollback");
  type Transaction = Parameters<Parameters<typeof database.transaction>[0]>[0];
  async function fixture(run: (f: { tx: Transaction; attempt: InstanceType<typeof TurnOutputAttempt>; state: ReturnType<GameStateManager["getSnapshot"]>; controller: AbortController; ids: { user: string; world: string; session: string; message: string }; args: ConstructorParameters<typeof TurnOutputAttempt>[0] }) => Promise<void>) {
    await assert.rejects(database.transaction(async (tx) => {
      const ids = { user: randomUUID(), world: randomUUID(), session: randomUUID(), message: randomUUID() };
      const state = new GameStateManager(world).getSnapshot();
      const controller = new AbortController();
      await tx.insert(schema.user).values({ id: ids.user, name: "Rollback guard fixture", email: `${ids.user}@invalid.example` });
      const [savedWorld] = await tx.insert(schema.worlds).values({ id: ids.world, creatorId: ids.user, name: "Rollback guard fixture", schema: world as unknown as Record<string, unknown> }).returning({ updatedAt: schema.worlds.updatedAt });
      await tx.insert(schema.playSessions).values({ id: ids.session, userId: ids.user, worldId: ids.world, state: state as unknown as Record<string, unknown> });
      await tx.insert(schema.messages).values({ id: ids.message, sessionId: ids.session, role: "user", content: "Guard fixture" });
      const args = {
        dispatch: { activeExtensions: new Map([["state-update-guard", new Set<string>()]]) },
        userId: ids.user, sessionId: ids.session, targetId: ids.message, path: "send" as const,
        world, baseline: state, model: "fixture", apiKeyTier: "fixture", startedAt: Date.now(),
        worldVersion: savedWorld!.updatedAt?.toISOString() ?? null, pendingVersion: null,
        worldId: ids.world, checkPending: false, signal: controller.signal,
      };
      const attempt = new TurnOutputAttempt(args, tx);
      await run({ tx, attempt, state, controller, ids, args });
      throw rollback;
    }), (error) => error === rollback);
  }
  await t.test("accepted audit and state commit together; duplicate attempt cannot reapply", () => fixture(async ({ tx, attempt, state, ids }) => {
    await attempt.begin();
    attempt.audit.outcome = "valid-updates";
    const final = structuredClone(state); final.variables.hp = 90;
    await attempt.checkCommit(tx, state, final);
    await tx.update(schema.playSessions).set({ state: final as unknown as Record<string, unknown> }).where(eq(schema.playSessions.id, ids.session));
    attempt.markCommitted();
    const [message] = await tx.select().from(schema.messages).where(eq(schema.messages.id, ids.message));
    assert.equal(message!.stateValidation?.outcome, "valid-updates");
    await assert.rejects(attempt.checkCommit(tx, final, final), /stale_state/);
  }));
  await t.test("unrelated UI write is permitted without overwriting it", () => fixture(async ({ tx, attempt, state }) => {
    await attempt.begin();
    const live = structuredClone(state); live.variables.ui = "closed";
    const final = structuredClone(state); final.variables.hp = 90;
    await attempt.checkCommit(tx, live, final);
    assert.equal(live.variables.ui, "closed");
  }));
  await t.test("overlapping UI write rejects all candidate effects", () => fixture(async ({ tx, attempt, state }) => {
    await attempt.begin();
    const live = structuredClone(state); live.variables.hp = 95;
    const final = structuredClone(state); final.variables.hp = 90;
    await assert.rejects(attempt.checkCommit(tx, live, final), /stale_state/);
    assert.equal(live.variables.hp, 95);
  }));
  await t.test("same-target concurrent attempt is refused", () => fixture(async ({ tx, attempt, args }) => {
    await attempt.begin();
    await assert.rejects(new TurnOutputAttempt(args, tx).begin(), /already_running/);
  }));
  await t.test("edited target cannot be overwritten", () => fixture(async ({ tx, attempt, state, ids }) => {
    await attempt.begin();
    await tx.update(schema.messages).set({ content: "Edited" }).where(eq(schema.messages.id, ids.message));
    await assert.rejects(attempt.checkCommit(tx, state, state), /stale_state/);
  }));
  await t.test("new timeline message invalidates old attempt", () => fixture(async ({ tx, attempt, state, ids }) => {
    await attempt.begin();
    await tx.insert(schema.messages).values({ sessionId: ids.session, role: "user", content: "Newer", createdAt: new Date(Date.now() + 1000) });
    await assert.rejects(attempt.checkCommit(tx, state, state), /stale_state/);
  }));
  await t.test("schema revision invalidates old attempt", () => fixture(async ({ tx, attempt, state, ids }) => {
    await attempt.begin();
    await tx.update(schema.worlds).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(schema.worlds.id, ids.world));
    await assert.rejects(attempt.checkCommit(tx, state, state), /stale_state/);
  }));
  await t.test("cancel after validation prevents commit and leaves terminal audit", () => fixture(async ({ tx, attempt, state, controller, ids }) => {
    await attempt.begin(); controller.abort();
    await assert.rejects(attempt.checkCommit(tx, state, state), /cancelled/);
    await attempt.finish(controller.signal);
    const [message] = await tx.select().from(schema.messages).where(eq(schema.messages.id, ids.message));
    assert.equal(message!.stateValidation?.outcome, "cancelled");
  }));
  await t.test("ownership is checked before creating an attempt", () => fixture(async ({ tx, args }) => {
    await assert.rejects(new TurnOutputAttempt({ ...args, userId: randomUUID() }, tx).begin(), /stale_target/);
  }));
  await t.test("rollback leaves no test users", async () => {
    const result = await database.execute(sql`SELECT count(*)::int AS count FROM "user" WHERE name = 'Rollback guard fixture' AND email LIKE '%@invalid.example'`);
    assert.equal(result.rows[0]?.count, 0);
  });
});
