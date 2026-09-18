import assert from "node:assert/strict";
import test from "node:test";
import { setReadAfterWriteFlag, type ReadAfterWriteFlagStore } from "./read-after-write.js";

test("read-after-write flagging is a no-op when Redis is unavailable", async () => {
  assert.equal(await setReadAfterWriteFlag(undefined, "user-1"), false);
});

test("read-after-write flagging waits for the expected Redis write", async () => {
  const calls: unknown[][] = [];
  const store: ReadAfterWriteFlagStore = {
    async set(...args) {
      calls.push(args);
      return "OK";
    },
  };

  assert.equal(await setReadAfterWriteFlag(store, "user-1"), true);
  assert.deepEqual(calls, [["rw:user-1", "1", "EX", 5]]);
});

test("Redis failures do not turn a successful publish into an API failure", async () => {
  const store: ReadAfterWriteFlagStore = {
    async set() {
      throw new Error("Redis unavailable");
    },
  };

  assert.equal(await setReadAfterWriteFlag(store, "user-1"), false);
});
