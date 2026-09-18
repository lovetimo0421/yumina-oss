import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { PLAY_ENGAGEMENT_LUA } from "./play-engagement.js";

test("UGC engagement requires input plus server time; idle, replay and hidden ticks fail closed", { skip: !process.env.ANALYTICS_TEST_REDIS_URL }, async () => {
  const redis = new Redis(process.env.ANALYTICS_TEST_REDIS_URL!, { maxRetriesPerRequest: 1, commandTimeout: 5000 });
  const key = "analytics:test:engagement:" + randomUUID();
  const tick = (at: number, seconds: number, input: boolean) => redis.eval(PLAY_ENGAGEMENT_LUA, 1, key, at, seconds, input ? "1" : "0");
  try {
    for (let t = 1_000_000; t <= 1_120_000; t += 15_000) assert.equal(await tick(t, 15, false), 0, "An open tab never qualifies");
    assert.equal(await tick(1_135_000, 15, true), 0);
    assert.equal(await tick(1_150_000, 15, true), 0);
    assert.equal(await tick(1_165_000, 15, true), 0);
    assert.equal(await tick(1_165_000, 90, true), 0, "Replay cannot advance the accumulator");
    assert.equal(await tick(1_180_000, 15, true), 0, "Time before first observed input is excluded");
    assert.equal(await tick(1_195_000, 15, true), 1, "Sixty server-awarded seconds qualify");
    assert.equal(await tick(1_210_000, 0, false), 0, "Pause or missing input clears engagement");
    assert.equal(await tick(1_310_000, 90, true), 0, "A disconnected interval starts fresh");
    assert.equal(await tick(1_290_000, 90, true), 0, "An older in-flight tick is ignored");
    assert.ok((await redis.ttl(key)) > 0, "Abandoned visit state expires");
  } finally {
    await redis.del(key);
    await redis.quit();
  }
});
