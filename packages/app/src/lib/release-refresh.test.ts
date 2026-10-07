import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshForNewRelease, shouldReloadForRelease } from "./release-refresh.js";

test("reloads only when the server has a different release", () => {
  assert.equal(shouldReloadForRelease("abc", "def", null), true);
  assert.equal(shouldReloadForRelease("abc", "abc", null), false);
  assert.equal(shouldReloadForRelease("", "def", null), false);
  assert.equal(shouldReloadForRelease("abc", undefined, null), false);
});

test("does not reload the same target release more than once", () => {
  assert.equal(shouldReloadForRelease("abc", "def", "def"), false);
  assert.equal(shouldReloadForRelease("abc", "ghi", "def"), true);
});

test("records the target release before reloading", async () => {
  const values = new Map<string, string>();
  let reloads = 0;

  const refreshed = await refreshForNewRelease("abc", {
    fetchImpl: async () => new Response(JSON.stringify({ release: "def" }), { status: 200 }),
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    reload: () => { reloads += 1; },
  });

  assert.equal(refreshed, true);
  assert.equal(reloads, 1);
  assert.deepEqual([...values.values()], ["def"]);
});

test("ignores unavailable or invalid release responses", async () => {
  const unavailable = await refreshForNewRelease("abc", {
    fetchImpl: async () => new Response(null, { status: 503 }),
    storage: { getItem: () => null, setItem: () => {} },
    reload: () => assert.fail("must not reload"),
  });
  const invalid = await refreshForNewRelease("abc", {
    fetchImpl: async () => new Response(JSON.stringify({ release: null }), { status: 200 }),
    storage: { getItem: () => null, setItem: () => {} },
    reload: () => assert.fail("must not reload"),
  });

  assert.equal(unavailable, false);
  assert.equal(invalid, false);
});
