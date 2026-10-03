import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { observePoolQueryTimings, type PoolQueryTiming } from "./query-timing.js";

test("queued acquisitions keep their own timings and preserve original query promises", async () => {
  let now = 0;
  const acquired: ((error: Error | null, client?: object) => void)[] = [];
  const complete: ((value: unknown) => void)[] = [];
  const promises: Promise<unknown>[] = [];
  const metrics: { sql: string; timing: PoolQueryTiming }[] = [];
  const pool = {
    connect(callback: (error: Error | null, client?: object) => void) { acquired.push(callback); },
    query(_sql: string) {
      const promise = new Promise((resolve, reject) => {
        this.connect((error) => error ? reject(error) : complete.push(resolve));
      });
      promises.push(promise); return promise;
    },
  };
  observePoolQueryTimings(pool as unknown as pg.Pool, (args, timing) => metrics.push({ sql: String(args[0]), timing }), () => now);
  const first = pool.query("first");
  assert.strictEqual(first, promises[0]);
  now = 10; const second = pool.query("second");
  now = 20; acquired[1]!(null, {});
  now = 30; complete[0]!("second-result");
  assert.equal(await second, "second-result");
  now = 50; acquired[0]!(null, {});
  now = 70; complete[1]!("first-result");
  assert.equal(await first, "first-result");
  assert.deepEqual(metrics, [
    { sql: "second", timing: { duration_ms: 20, connection_acquire_ms: 10, database_roundtrip_ms: 10 } },
    { sql: "first", timing: { duration_ms: 70, connection_acquire_ms: 50, database_roundtrip_ms: 20 } },
  ]);
});

test("diagnostic exceptions and rejected queries do not change the caller's result", async () => {
  const error = new Error("database unavailable");
  const pool = { connect() {}, query(sql: string) { return sql === "fail" ? Promise.reject(error) : Promise.resolve(42); } };
  observePoolQueryTimings(pool as unknown as pg.Pool, () => { throw new Error("analytics unavailable"); });
  assert.equal(await pool.query("ok"), 42);
  await assert.rejects(pool.query("fail"), (caught) => caught === error);
});

test("callback overloads and standalone transaction acquisitions remain unchanged", () => {
  const sentinel = {};
  let observed = false;
  const callback = () => {};
  const pool = {
    connect(...args: unknown[]) { assert.deepEqual(args, []); return sentinel; },
    query(...args: unknown[]) { assert.deepEqual(args, ["select 1", callback]); return sentinel; },
  };
  observePoolQueryTimings(pool as unknown as pg.Pool, () => { observed = true; });
  assert.strictEqual(pool.query("select 1", callback), sentinel);
  assert.strictEqual(pool.connect(), sentinel);
  assert.equal(observed, false);
});
