import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { fetchBlueprintAccess, resetBlueprintAccessCache } from "./blueprint-access";

type FetchLike = typeof globalThis.fetch;

function stubFetch(handler: () => Promise<unknown>) {
  (globalThis as { fetch: FetchLike }).fetch = (() => handler()) as unknown as FetchLike;
}

beforeEach(() => {
  resetBlueprintAccessCache();
});

test("the server can close the blueprint", async () => {
  stubFetch(async () => ({ ok: true, json: async () => ({ data: { blueprint: false } }) }));
  assert.equal(await fetchBlueprintAccess(), false);
});

test("an answer that says nothing about the blueprint keeps it", async () => {
  stubFetch(async () => ({ ok: true, json: async () => ({ data: {} }) }));
  assert.equal(await fetchBlueprintAccess(), true);
});

test("an error is not the feature being taken away", async () => {
  stubFetch(async () => ({ ok: false, json: async () => ({}) }));
  assert.equal(await fetchBlueprintAccess(), true);
  resetBlueprintAccessCache();
  stubFetch(async () => { throw new Error("offline"); });
  assert.equal(await fetchBlueprintAccess(), true);
});

test("a wedged endpoint cannot strand the editor on a spinner", async () => {
  // The real shape of the 2026-09-18 dev-server fault: the request is accepted
  // and then never answers. Callers await this before deciding which editor a
  // card opens in, so a hang here is a card that never opens.
  stubFetch(() => new Promise(() => {}));
  const started = Date.now();
  assert.equal(await fetchBlueprintAccess(), true);
  assert.ok(Date.now() - started < 5000, "the wait is bounded");
});

test("the answer is fetched once and shared", async () => {
  let calls = 0;
  stubFetch(async () => { calls += 1; return { ok: true, json: async () => ({ data: { blueprint: false } }) }; });
  const [a, b] = await Promise.all([fetchBlueprintAccess(), fetchBlueprintAccess()]);
  assert.equal(a, false);
  assert.equal(b, false);
  assert.equal(await fetchBlueprintAccess(), false);
  assert.equal(calls, 1);
});
