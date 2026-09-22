import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { settleParallel } from "./settle-parallel.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("fulfilled values retain input order and tuple types despite completion order", async () => {
  const first = deferred<number>();
  const second = deferred<string>();
  const result = settleParallel([first.promise, second.promise, true] as const);
  second.resolve("second");
  first.resolve(1);
  const tuple: [number, string, true] = await result;
  assert.deepEqual(tuple, [1, "second", true]);
  assert.deepEqual(await settleParallel([]), []);
});

test("drains fulfilling and rejecting siblings while preserving the first observed rejection", async () => {
  const first = deferred<number>(), second = deferred<number>(), third = deferred<number>();
  const original = new Error("second input failed first");
  let settled = false;
  const result = settleParallel([first.promise, second.promise, third.promise]).then(
    () => { settled = true; assert.fail("expected rejection"); },
    reason => { settled = true; return reason; },
  );
  try {
    second.reject(original);
    await setImmediate();
    assert.equal(settled, false);
    first.reject(new Error("first input failed later"));
    await setImmediate();
    assert.equal(settled, false, "later rejection must not abandon the last sibling");
  } finally {
    first.resolve(1);
    third.resolve(3);
  }
  assert.equal(await result, original);
});

test("undefined is preserved as the first rejection reason", async () => {
  const first = deferred<number>(), second = deferred<number>();
  const result = settleParallel([first.promise, second.promise]).then(
    () => ({ status: "fulfilled" as const }),
    reason => ({ status: "rejected" as const, reason }),
  );
  first.reject(undefined);
  await setImmediate();
  second.reject(new Error("later"));
  assert.deepEqual(await result, { status: "rejected", reason: undefined });
});

test("each lazy query thenable executes once while a failed sibling drains", async () => {
  const blocked = deferred<number>();
  let executions = 0;
  const query: PromiseLike<number> = {
    then(onfulfilled, onrejected) {
      executions++;
      return blocked.promise.then(onfulfilled, onrejected);
    },
  };
  const failure = new Error("failed sibling");
  const result = settleParallel([query, Promise.reject(failure)]).catch(reason => reason);
  await setImmediate();
  blocked.resolve(1);
  assert.equal(await result, failure);
  assert.equal(executions, 1, "draining must not re-execute a Drizzle query thenable");
});
