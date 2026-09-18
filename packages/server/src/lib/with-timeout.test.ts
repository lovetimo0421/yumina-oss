import test from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "./with-timeout.js";

test("withTimeout returns the resolved value when it beats the timeout", async () => {
  const r = await withTimeout(Promise.resolve("ok"), 50, () => "fallback");
  assert.equal(r, "ok");
});

test("withTimeout returns the fallback when the promise is slower than the timeout", async () => {
  const slow = new Promise<string>((res) => setTimeout(() => res("late"), 100));
  const r = await withTimeout(slow, 15, () => "fallback");
  assert.equal(r, "fallback");
});

test("withTimeout propagates a rejection that happens before the timeout", async () => {
  const failing = Promise.reject(new Error("boom"));
  await assert.rejects(() => withTimeout(failing, 50, () => "fallback"), /boom/);
});

test("withTimeout ignores a rejection that happens after it already timed out", async () => {
  // Should resolve to fallback and NOT throw an unhandled rejection.
  const lateReject = new Promise<string>((_, rej) => setTimeout(() => rej(new Error("late")), 60));
  const r = await withTimeout(lateReject, 15, () => "fallback");
  assert.equal(r, "fallback");
});
