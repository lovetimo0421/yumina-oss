import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { installVoiceLiveCalls, voiceLiveCallsSql } from "../db/voice-live-calls.js";
import { LiveCreditCalls, LIVE_CREDITS_PER_MINUTE, LIVE_MAX_MINUTES, LIVE_IDLE_MS, type LiveCreditDeps } from "./voice-live-credits.js";
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
  assert.deepEqual(await calls.config("u1", "s1"), { available: false, funding: "credits-live", creditsPerMinute: 60, maxDurationSeconds: LIVE_MAX_MINUTES * 60, code: "VOICE_CREDITS_REQUIRED" });
  f.wallet.set("u1", 60);
  assert.deepEqual(await calls.config("u1", "s1"), { available: true, funding: "credits-live", creditsPerMinute: 60, maxDurationSeconds: LIVE_MAX_MINUTES * 60 });
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

test("the ceiling (a bug backstop) hangs up an always-active call, having paid for every minute", async () => {
  const f = await fixture(LIVE_MAX_MINUTES * LIVE_CREDITS_PER_MINUTE + 100), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_cap");
  for (let s = 0; s < LIVE_MAX_MINUTES * 60; s += 15) { f.tick(15_000); await calls.heartbeat("u1", "s1", 0); await calls.sweep(); }
  const r = (await f.row())[0]!;
  assert.equal(r.state, "closed"); assert.equal(r.close_reason, "cap"); assert.equal(r.paid_minutes, LIVE_MAX_MINUTES);
  assert.equal(f.ledger.size, LIVE_MAX_MINUTES);
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
  f.tick(50_000); assert.equal((await calls.heartbeat("u1", "s1")).alive, true); await calls.sweep();
  assert.equal((await f.row())[0]!.state, "active");
  f.tick(80_000); await calls.sweep();
  const r = (await f.row())[0]!;
  assert.equal(r.state, "closed"); assert.equal(r.close_reason, "abandoned");
  assert.equal((await calls.heartbeat("u1", "s1")).alive, false, "an ended call cannot be revived");
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

// --- Idle ending (owner 2026-10-24): a call ends when nobody is playing, not at a fixed clock. ---

/** Beat every 30 s like the browser, reporting the given idle time, sweeping every 15 s. */
async function play(f: Awaited<ReturnType<typeof fixture>>, calls: LiveCreditCalls, seconds: number, idleAt: (t: number) => number) {
  for (let t = 15; t <= seconds; t += 15) {
    f.tick(15_000);
    if (t % 30 === 0) await calls.heartbeat("u1", "s1", idleAt(t));
    await calls.sweep();
  }
}

test("a player who keeps playing is never cut off and pays for every minute", async () => {
  const f = await fixture(5000), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_play");
  await play(f, calls, 25 * 60, () => 5_000);
  const r = (await f.row())[0]!;
  assert.equal(r.state, "active");
  assert.equal(r.paid_minutes, 26, "minute 26 is charged 10 s before it starts");
  assert.equal(f.ledger.size, 26);
});

test("nobody playing: the call ends at three idle minutes, and the minute due in the warning window is not charged", async () => {
  const f = await fixture(5000), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_idle");
  let idle = 0;
  await play(f, calls, 6 * 60, t => (idle = t * 1000));
  const r = (await f.row())[0]!;
  assert.equal(r.state, "closed"); assert.equal(r.close_reason, "idle");
  // Minutes 1-3 were started while the player could still be there (idle < 2.5 min at 0, 50, 110 s);
  // minute 4 comes due at 170 s, already in the warning window, so the call ends instead.
  assert.equal(r.paid_minutes, 3);
  assert.deepEqual(f.hangups, ["rtc_idle"]);
  assert.deepEqual(await calls.heartbeat("u1", "s1", 0), { alive: false, reason: "idle" }, "the browser is told why");
  assert.ok(idle >= LIVE_IDLE_MS - 30_000);
});

test("coming back just before the deadline keeps the call", async () => {
  const f = await fixture(5000), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_back");
  await play(f, calls, 140, t => t * 1000);          // idle for 140 s, under the warning line
  await calls.heartbeat("u1", "s1", 0);               // the player moves: the browser beats at once
  await play(f, calls, 120, () => 0);
  assert.equal((await f.row())[0]!.state, "active");
});

test("activity only moves forward: a late, stale beat cannot rewind it", async () => {
  const f = await fixture(5000), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_order");
  f.tick(60_000);
  await calls.heartbeat("u1", "s1", 0);               // active at 60 s
  await calls.heartbeat("u1", "s1", 55_000);          // an older beat arriving late: would mean 5 s
  const activeAt = (await f.row())[0]!.last_active_at;
  assert.equal(new Date(activeAt as string).getTime(), Date.parse("2026-10-19T10:01:00Z"), "still 60 s, not rewound to 5 s");
  f.tick(50_000); await calls.heartbeat("u1", "s1", 50_000);
  f.tick(50_000); await calls.sweep();
  assert.equal((await f.row())[0]!.state, "active", "idle is 100 s, not 155 s");
});

test("absurd idle reports are clamped and negative ones count as now", async () => {
  const f = await fixture(5000), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_clamp");
  f.tick(30_000);
  assert.equal((await calls.heartbeat("u1", "s1", -99_999)).alive, true);
  assert.equal((await calls.heartbeat("u1", "s1", Number.NaN)).alive, true);
  assert.equal((await calls.heartbeat("u1", "s1", 9e15)).alive, true, "a huge report is clamped, not an error");
  f.tick(15_000); await calls.sweep();
  assert.equal((await f.row())[0]!.state, "active", "a huge report never moves activity backwards past the last real one");
});

test("an older browser that sends no idle time counts as active (ended only by a closed tab or the ceiling)", async () => {
  const f = await fixture(5000), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_old");
  for (let t = 0; t < 10 * 60; t += 30) { f.tick(30_000); await calls.heartbeat("u1", "s1"); await calls.sweep(); }
  assert.equal((await f.row())[0]!.state, "active");
});

test("the idle clock survives a restart", async () => {
  const f = await fixture(5000), before = f.calls();
  const id = await before.begin("u1", "s1"); await before.activate(id, "rtc_rs");
  f.tick(30_000); await before.heartbeat("u1", "s1", 30_000);
  const after = f.calls();
  for (let t = 0; t < 200; t += 15) { f.tick(15_000); if (t % 30 === 0) await after.heartbeat("u1", "s1", 60_000 + t * 1000); await after.sweep(); }
  assert.equal((await f.row())[0]!.close_reason, "idle");
});

test("the beat warns when the wallet cannot pay the next minute", async () => {
  const f = await fixture(1000), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_low");
  assert.deepEqual(await calls.heartbeat("u1", "s1", 0), { alive: true, lowBalance: false });
  f.wallet.set("u1", LIVE_CREDITS_PER_MINUTE - 1);
  assert.deepEqual(await calls.heartbeat("u1", "s1", 0), { alive: true, lowBalance: true });
});

test("a call that predates activity tracking is not hung up by the first sweep after a deploy", async () => {
  const f = await fixture(5000), calls = f.calls();
  const id = await calls.begin("u1", "s1"); await calls.activate(id, "rtc_predeploy");
  // As the deployed table would hold it: no activity recorded, ten minutes in, beat just now.
  await f.db.execute(sql`UPDATE voice_live_calls SET last_active_at = NULL, started_at = ${new Date(Date.parse("2026-10-19T09:50:00Z")).toISOString()}, paid_minutes = 10 WHERE id = ${id}`);
  await calls.sweep();
  assert.equal((await f.row())[0]!.state, "active");
});
