import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { installVoiceLiveCalls, voiceLiveCallsSql } from "../db/voice-live-calls.js";
import { LiveCreditCalls, LIVE_CREDITS_PER_MINUTE, type LiveCreditDeps } from "./voice-live-credits.js";
import { VoiceConnectionError } from "./voice-realtime.js";
import type { LedgerDatabase } from "./transaction-hash.js";

const open: PGlite[] = [];
after(async () => { await Promise.all(open.map(pg => pg.close())); });
async function fixture(balance = 1000) {
  const pg = new PGlite(); open.push(pg);
  await pg.exec(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES ('u1'),('u2');`);
  const db = drizzle(pg) as unknown as LedgerDatabase;
  await installVoiceLiveCalls(db);
  const wallet = new Map<string, number>([["u1", balance], ["u2", balance]]);
  const ledger = new Map<string, number>();
  const hangups: string[] = [];
  let clock = Date.parse("2026-10-19T10:00:00Z"), hangupFails = 0, world = true;
  const deps: LiveCreditDeps = {
    db,
    async deduct(user, credits, reference) {
      if (ledger.has(reference)) return;
      if ((wallet.get(user) ?? 0) < credits) throw new Error("INSUFFICIENT_CREDITS");
      wallet.set(user, wallet.get(user)! - credits); ledger.set(reference, credits);
    },
    available: async user => wallet.get(user) ?? 0,
    isWorld: async () => world,
    async hangup(id) { if (hangupFails > 0) { hangupFails--; throw new Error("down"); } hangups.push(id); },
    now: () => clock,
  };
  const row = async () => ((await db.execute(sql`SELECT * FROM voice_live_calls ORDER BY created_at`)) as unknown as { rows: Record<string, unknown>[] }).rows;
  return {
    deps, db, wallet, ledger, hangups, row, calls: () => new LiveCreditCalls(deps),
    tick: (ms: number) => { clock += ms; }, failHangups: (n: number) => { hangupFails = n; }, setWorld: (v: boolean) => { world = v; },
  };
}
const MIN = 60_000;

test("the SQL file applied by hand is exactly the boot DDL", () => {
  const file = readFileSync(new URL("../../scripts/voice-live-calls.sql", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
  assert.equal(file.replace(/^(--.*\n)+/, ""), voiceLiveCallsSql());
});

test("no live-call index is named voice_* (the voice-billing snapshot fingerprints those)", () => {
  // Prod incident 2026-10-19: voice_live_calls_* indexes changed the voice-billing schema
  // snapshot, so checkBalance threw VOICE_SCHEMA_NOT_READY and every chat message failed.
  const names = [...voiceLiveCallsSql().matchAll(/INDEX IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  assert.ok(names.length >= 3);
  for (const name of names) assert.ok(!/^voice_/.test(name!), `${name} must not start with voice_`);
});

test("config is offered only for the priced world, and says when credits are short", async () => {
  const f = await fixture(30), calls = f.calls();
  f.setWorld(false);
  assert.equal(await calls.config("u1", "s1"), null);
  f.setWorld(true);
  assert.deepEqual(await calls.config("u1", "s1"), { available: false, funding: "credits-live", creditsPerMinute: 60, maxDurationSeconds: 900, code: "VOICE_CREDITS_REQUIRED" });
  f.wallet.set("u1", 60);
  assert.deepEqual(await calls.config("u1", "s1"), { available: true, funding: "credits-live", creditsPerMinute: 60, maxDurationSeconds: 900 });
  await assert.rejects(f.calls().begin("u2", "s1").then(() => { f.wallet.set("u2", 0); return f.calls().begin("u2", "s2"); }), (e: unknown) => e instanceof VoiceConnectionError);
});

test("the first minute is charged once the provider call exists, exactly once", async () => {
  const f = await fixture(), calls = f.calls();
  const id = await calls.begin("u1", "s1", "c1");
  assert.equal(await calls.activate(id, "rtc_1"), true);
  assert.equal(await calls.activate(id, "rtc_1"), false, "a replayed activation does nothing");
  assert.equal(f.wallet.get("u1"), 1000 - LIVE_CREDITS_PER_MINUTE);
  assert.deepEqual([...f.ledger.keys()], [`voice-live:${id}:1`]);
  assert.equal((await f.row())[0]!.paid_minutes, 1);
});

test("a wallet that cannot pay the first minute is refused and the call hung up", async () => {
  const f = await fixture(1000), calls = f.calls();
  const id = await calls.begin("u1", "s1");
  f.wallet.set("u1", 10);
  assert.equal(await calls.activate(id, "rtc_poor"), false);
  assert.equal((await f.row())[0]!.state, "closing");
  await calls.sweep();
  assert.deepEqual(f.hangups, ["rtc_poor"]);
  assert.equal((await f.row())[0]!.state, "closed");
  assert.equal((await f.row())[0]!.close_reason, "balance");
});

test("each started minute is charged once, even when two instances sweep at the same moment", async () => {
  const f = await fixture(), a = f.calls(), b = f.calls();
  const id = await a.begin("u1", "s1"); await a.activate(id, "rtc_2");
  f.tick(30_000); await a.heartbeat("u1", "s1");
  await Promise.all([a.sweep(), b.sweep()]);
  assert.equal(f.ledger.size, 1, "minute 2 is not due yet");
  f.tick(25_000); await a.heartbeat("u1", "s1");
  await Promise.all([a.sweep(), b.sweep()]);
  await Promise.all([a.sweep(), b.sweep()]);
  f.tick(31_000);
  await Promise.all([a.sweep(), b.sweep()]);
  assert.deepEqual([...f.ledger.keys()], [`voice-live:${id}:1`, `voice-live:${id}:2`]);
  assert.equal(f.wallet.get("u1"), 1000 - 2 * LIVE_CREDITS_PER_MINUTE);
  assert.equal((await f.row())[0]!.paid_minutes, 2);
});

test("the call is hung up at the 15-minute cap, having paid for 15 minutes", async () => {
  const f = await fixture(5000), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_cap");
  for (let s = 0; s < 15 * 60; s += 15) { f.tick(15_000); await calls.heartbeat("u1", "s1"); await calls.sweep(); }
  const r = (await f.row())[0]!;
  assert.equal(r.state, "closed"); assert.equal(r.close_reason, "cap"); assert.equal(r.paid_minutes, 15);
  assert.equal(f.ledger.size, 15);
  assert.deepEqual(f.hangups, ["rtc_cap"]);
});

test("running out of credits mid-call ends it at the unpaid minute", async () => {
  const f = await fixture(130), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_out");
  for (const step of [55_000, 55_000]) { f.tick(step); await calls.heartbeat("u1", "s1"); await calls.sweep(); }
  assert.equal(f.ledger.size, 2);
  f.tick(55_000); await calls.heartbeat("u1", "s1"); await calls.sweep();
  const r = (await f.row())[0]!;
  assert.equal(r.state, "closed"); assert.equal(r.close_reason, "balance"); assert.equal(f.wallet.get("u1"), 10);
  assert.deepEqual(f.hangups, ["rtc_out"]);
});

test("a tab that stops beating is hung up; a beating one is not", async () => {
  const f = await fixture(), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_tab");
  f.tick(50_000); assert.equal(await calls.heartbeat("u1", "s1"), true); await calls.sweep();
  assert.equal((await f.row())[0]!.state, "active");
  f.tick(80_000); await calls.sweep();
  const r = (await f.row())[0]!;
  assert.equal(r.state, "closed"); assert.equal(r.close_reason, "abandoned");
  assert.equal(await calls.heartbeat("u1", "s1"), false, "an ended call cannot be revived");
});

test("a hangup OpenAI refuses still closes the call, so it never blocks the next one", async () => {
  // Prod 2026-10-22: OpenAI's live hangup answered 503 and the row stayed 'closing', refusing every new call.
  const f = await fixture(), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_retry");
  f.failHangups(5);
  await calls.stop("u1", "s1");
  const r = (await f.row())[0]!;
  assert.equal(r.state, "closed"); assert.equal(r.close_reason, "stopped");
  assert.equal(typeof await calls.begin("u1", "s2"), "string", "the next call starts at once");
});

test("a new call replaces the account's older open call and stops its billing", async () => {
  const f = await fixture(), calls = f.calls();
  const first = await calls.begin("u1", "s1"); await calls.activate(first, "rtc_old");
  const second = await calls.begin("u1", "s2");
  const rows = await f.row();
  const old = rows.find(x => x.id === first)!, next = rows.find(x => x.id === second)!;
  assert.equal(old.state, "closed"); assert.equal(old.close_reason, "replaced");
  assert.equal(next.state, "connecting");
  f.tick(120_000); await calls.sweep();
  assert.equal(f.ledger.size, 1, "the replaced call is never charged again");
});

test("after a restart a fresh instance finds the open call, bills it and ends it", async () => {
  const f = await fixture(), before = f.calls();
  const id = await before.begin("u1", "s1"); await before.activate(id, "rtc_restart");
  const after = f.calls(); // the old process is gone; nothing in memory survives
  f.tick(55_000); await after.heartbeat("u1", "s1"); await after.sweep();
  assert.equal(f.ledger.size, 2);
  f.tick(100_000); await after.sweep();
  assert.equal((await f.row())[0]!.state, "closed");
  assert.deepEqual(f.hangups, ["rtc_restart"]);
});

test("a call that never connected frees the account after two minutes", async () => {
  const f = await fixture(), calls = f.calls();
  await calls.begin("u1", "s1");
  f.tick(121_000);
  const id = await calls.begin("u1", "s1");
  assert.equal(typeof id, "string");
  assert.equal(f.ledger.size, 0, "nothing was charged for the failed connection");
});
