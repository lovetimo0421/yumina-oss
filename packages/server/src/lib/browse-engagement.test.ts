import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { BROWSE_ENGAGEMENT_LUA } from "./browse-engagement.js";

test("browsing requires separated inputs and sixty server seconds, rejects idle, replay and competing tabs", { skip: !process.env.ANALYTICS_TEST_REDIS_URL }, async () => {
  const redis = new Redis(process.env.ANALYTICS_TEST_REDIS_URL!, { maxRetriesPerRequest: 1, commandTimeout: 5000 });
  const key = "analytics:test:browse:" + randomUUID();
  const tick = (at: number, seq: number, input: number, active = true, lease = "one") => redis.eval(BROWSE_ENGAGEMENT_LUA, 1, key, at, lease, seq, active ? "1" : "0", input);
  try {
    assert.equal(await tick(100000, 1, 1), 0);
    assert.equal(await tick(115000, 2, 1), 0);
    assert.equal(await tick(130000, 3, 1), 0);
    assert.equal(await tick(145000, 4, 1), 0);
    assert.equal(await tick(160000, 5, 1), 0, "One initial click cannot qualify an idle tab");
    assert.equal(await tick(175000, 6, 2), 1);
    assert.equal(await tick(180000, 6, 10), 0, "Replayed sequence cannot earn time");
    assert.equal(await tick(181000, 1, 10, true, "two"), 0, "Second tab cannot add time");
    assert.equal(await tick(190000, 7, 2, false), 0);
    assert.equal(await tick(205000, 8, 3), 0, "Resume needs a fresh minute");
    assert.equal(await tick(400000, 9, 4), 0, "Network gaps do not count");
    assert.ok(await redis.ttl(key) > 0);
  } finally { await redis.del(key); await redis.quit(); }
});
