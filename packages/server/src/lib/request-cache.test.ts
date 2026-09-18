import assert from "node:assert/strict";
import test from "node:test";
import {
  getOrCreateRequestPromise,
  invalidateRequestCachePrefix,
  runWithRequestCache,
} from "./request-cache.js";

test("deduplicates sequential and concurrent work inside one request", async () => {
  let calls = 0;
  await runWithRequestCache(async () => {
    const factory = async () => {
      calls += 1;
      return "ultra";
    };
    const [first, second] = await Promise.all([
      getOrCreateRequestPromise("event-plan:user:free", factory),
      getOrCreateRequestPromise("event-plan:user:free", factory),
    ]);
    const third = await getOrCreateRequestPromise("event-plan:user:free", factory);
    assert.deepEqual([first, second, third], ["ultra", "ultra", "ultra"]);
  });
  assert.equal(calls, 1);
});

test("can invalidate cached entitlement results after a grant", async () => {
  let calls = 0;
  await runWithRequestCache(async () => {
    const factory = async () => ++calls;
    assert.equal(await getOrCreateRequestPromise("event-plan:user:free", factory), 1);
    invalidateRequestCachePrefix("event-plan:user:");
    assert.equal(await getOrCreateRequestPromise("event-plan:user:free", factory), 2);
  });
});
