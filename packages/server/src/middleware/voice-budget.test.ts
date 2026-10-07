import test from "node:test";
import assert from "node:assert/strict";

test("shared daily budgets survive housekeeping and expire only after 24 hours", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
  const { slidingWindowCheck, stopRateLimitCleanup } = await import("./rate-limit.js");
  try {
    const key = "test:voice:daily";
    for (let i = 0; i < 12; i++) assert.equal(await slidingWindowCheck(key, 12, 86_400_000), null);
    t.mock.timers.tick(120_000);
    assert.ok(await slidingWindowCheck(key, 12, 86_400_000), "housekeeping must retain daily starts after two minutes");
    t.mock.timers.tick(86_400_000);
    assert.equal(await slidingWindowCheck(key, 12, 86_400_000), null);
  } finally { stopRateLimitCleanup(); t.mock.timers.reset(); }
});
