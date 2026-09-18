import test from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_CLAIM_TTL_MS, SummaryJobManager, type SummaryJobStore, type SummaryRunControl } from "./summary-job-core.js";

function makeStore(): SummaryJobStore {
  const values = new Map<string, string>();
  return { get: async key => values.get(key) ?? null, compareAndSet: async (key, previous, next) => {
    if ((values.get(key) ?? null) !== previous) return false;
    values.set(key, next); return true;
  } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await tick(); }
  assert.fail("job did not reach expected state");
}

test("two replicas return one job immediately and retain progress for reconnect", async () => {
  const store = makeStore();
  const a = new SummaryJobManager(store), b = new SummaryJobManager(store);
  let runs = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = async (control: SummaryRunControl) => { runs++; await control.progress(1, 3, "episodes"); await gate; await control.progress(3, 3, "merge"); };
  const receipts = await Promise.all([a.start("session", run), b.start("session", run)]);
  assert.equal(receipts[0]!.id, receipts[1]!.id);
  assert.equal(receipts[0]!.status, "queued");
  await until(async () => (await b.read("session"))?.completed === 1);
  assert.equal(runs, 1);
  assert.equal((await b.start("session", run)).id, receipts[0]!.id);
  release();
  await until(async () => (await b.read("session"))?.status === "completed");
});

test("failure stores its actual error and permits a new bounded attempt", async () => {
  const manager = new SummaryJobManager(makeStore());
  const first = await manager.start("session", async () => { throw new Error("output limit before completing"); });
  await until(async () => (await manager.read("session"))?.status === "failed");
  assert.match((await manager.read("session"))!.error!, /output limit/);
  const second = await manager.start("session", async () => {});
  assert.notEqual(second.id, first.id);
  await until(async () => (await manager.read("session"))?.status === "completed");
});

test("an abandoned worker cannot overwrite its replacement", async () => {
  let now = 1000, release!: () => void;
  const store = makeStore();
  const a = new SummaryJobManager(store, () => now), b = new SummaryJobManager(store, () => now);
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = await a.start("session", async () => { await gate; });
  await until(async () => (await a.read("session"))?.status === "running");
  now += SUMMARY_CLAIM_TTL_MS;
  assert.equal((await b.read("session"))?.status, "running", "do not offer retry before the database claim expires");
  now += 31_000;
  assert.equal((await b.read("session"))?.status, "failed");
  const second = await b.start("session", async () => {});
  release();
  await until(async () => (await b.read("session"))?.status === "completed");
  assert.notEqual(first.id, second.id);
  assert.equal((await a.read("session"))?.id, second.id);
});

test("unavailable shared store fails closed without running provider work", async () => {
  let runs = 0;
  const manager = new SummaryJobManager({ get: async () => { throw new Error("Redis unavailable"); }, compareAndSet: async () => false });
  await assert.rejects(manager.start("session", async () => { runs++; }), /Redis unavailable/);
  assert.equal(runs, 0);
});

test("different sessions are independent", async () => {
  const manager = new SummaryJobManager(makeStore());
  const [a, b] = await Promise.all([manager.start("a", async () => {}), manager.start("b", async () => {})]);
  assert.notEqual(a.id, b.id);
  await until(async () => (await manager.read("a"))?.status === "completed" && (await manager.read("b"))?.status === "completed");
});
