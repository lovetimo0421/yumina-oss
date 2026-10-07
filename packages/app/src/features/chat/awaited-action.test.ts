import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAwaitedAction } from "./awaited-action";

test("awaited-action host responds to unavailable, malformed, synchronous and asynchronous failures", async () => {
  let calls = 0;
  const execute = async () => { calls++; return { applied: true as const, variables: {}, firedIds: [] }; };
  for (const [args, available, handler] of [[[], true, execute], [[""], true, execute], [["entry", "extra"], true, execute], [["entry"], false, execute], [["entry"], true, undefined]] as const) {
    assert.ok("error" in await dispatchAwaitedAction([...args], available, handler));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await dispatchAwaitedAction(["entry"], true, execute), { applied: true, variables: {}, firedIds: [] });
  for (const handler of [() => { throw Error("sync"); }, async () => { throw Error("async"); }]) {
    assert.match((await dispatchAwaitedAction(["entry"], true, handler) as { error: string }).error, /sync/);
  }
});

test("a button's parameters ride along as a plain object", async () => {
  let got: unknown = null;
  const execute = async (_id: string, params?: Record<string, unknown>) => { got = params; return { applied: true as const, variables: {}, firedIds: [] }; };
  await dispatchAwaitedAction(["购买", { 商品: "伞", 价格: 30 }], true, execute);
  assert.deepEqual(got, { 商品: "伞", 价格: 30 });
  assert.ok("error" in await dispatchAwaitedAction(["购买", ["伞"]], true, execute));
});
