import assert from "node:assert/strict";
import test from "node:test";
import { createHealthRoutes } from "./health-check.js";

test("liveness succeeds without touching unavailable dependencies", async () => {
  let calls = 0;
  const routes = createHealthRoutes({ db: () => { calls++; return new Promise(() => {}); } }, { timeoutMs: 10 });
  const response = await routes.request("/live");
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("concurrent health requests and repeated timeouts cannot multiply stuck probes", async () => {
  let calls = 0, release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const routes = createHealthRoutes({ db: () => { calls++; return blocked; } }, { timeoutMs: 10, cacheMs: 0 });
  const responses = await Promise.all(Array.from({ length: 30 }, () => routes.request("/")));
  assert.ok(responses.every((response) => response.status === 503));
  assert.equal(calls, 1, "one in-flight probe per dependency, not per HTTP request");
  for (let i = 0; i < 5; i++) assert.equal((await routes.request("/")).status, 503);
  assert.equal(calls, 1, "timing out the response must not forget the running query");
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await routes.request("/")).status, 200);
  assert.equal(calls, 2, "recover once the original query settles");
});

test("readiness distinguishes dependency failures and coalesces successful checks", async () => {
  let calls = 0;
  const routes = createHealthRoutes({
    db: async () => { calls++; },
    redis: async () => { throw new Error("offline"); },
  }, { timeoutMs: 20, cacheMs: 1000 });
  const first = await routes.request("/");
  assert.equal(first.status, 503);
  assert.deepEqual((await first.json() as { checks: unknown }).checks, { db: "ok", redis: "down" });
  await routes.request("/");
  assert.equal(calls, 1);
  assert.equal(first.headers.get("cache-control"), "no-store");
});

test("a synchronous probe failure is degraded health, and reporting cannot break the endpoint", async () => {
  const routes = createHealthRoutes({ db: () => { throw new Error("failed synchronously"); } }, {
    timeoutMs: 10, onDegraded: () => { throw new Error("telemetry unavailable"); },
  });
  const response = await routes.request("/");
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json() as { checks: unknown }).checks, { db: "down" });
});
