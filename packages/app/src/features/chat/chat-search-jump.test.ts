import assert from "node:assert/strict";
import test from "node:test";
import {
  loadUntilMessage,
  pageBudget,
  splitHighlight,
  waitForPage,
  type HistoryWindowState,
} from "../../../sandbox/chat/search-jump";

/** A host holding the newest `loaded` of `total` rows, paging 200 at a time. */
function fakeHost(total: number, loaded: number, options: { failAfter?: number } = {}) {
  const all = Array.from({ length: total }, (_, i) => ({ id: `m${i + 1}` }));
  let start = total - loaded;
  let loads = 0;
  const state = (): HistoryWindowState => ({
    sessionId: "s1",
    messages: all.slice(start),
    hasEarlierMessages: start > 0,
    isLoadingEarlier: false,
    firstMessageNumber: start + 1,
  });
  return {
    state,
    loads: () => loads,
    load: async () => {
      loads++;
      if (options.failAfter !== undefined && loads > options.failAfter) return false;
      start = Math.max(0, start - 200);
      return true;
    },
  };
}

test("a hit already in the window needs no page", async () => {
  const host = fakeHost(1000, 200);
  const ok = await loadUntilMessage({ messageId: "m900", position: 900, current: host.state, load: host.load, committed: async () => {} });
  assert.equal(ok, true);
  assert.equal(host.loads(), 0);
});

test("a hit far back loads exactly the pages up to it", async () => {
  const host = fakeHost(1000, 200);
  const ok = await loadUntilMessage({ messageId: "m150", position: 150, current: host.state, load: host.load, committed: async () => {} });
  assert.equal(ok, true);
  // Window starts at #801; #150 needs pages to #601, #401, #201, #1.
  assert.equal(host.loads(), 4);
  assert.ok(host.state().messages.some((row) => row.id === "m150"));
});

test("a failed page, a missing message or a changed session stops the walk", async () => {
  const failing = fakeHost(1000, 200, { failAfter: 1 });
  assert.equal(await loadUntilMessage({ messageId: "m10", position: 10, current: failing.state, load: failing.load, committed: async () => {} }), false);
  const host = fakeHost(400, 200);
  assert.equal(await loadUntilMessage({ messageId: "deleted", position: 5, current: host.state, load: host.load, committed: async () => {} }), false);
  assert.ok(host.loads() <= pageBudget({ firstMessageNumber: 201 }, 5));
  const controller = new AbortController();
  controller.abort();
  const fresh = fakeHost(1000, 200);
  assert.equal(await loadUntilMessage({ messageId: "m1", position: 1, current: fresh.state, load: fresh.load, committed: async () => {}, signal: controller.signal }), false);
  assert.equal(fresh.loads(), 0);
});

test("waiting for a page resolves when the window moves", async () => {
  const host = fakeHost(1000, 200);
  const before = host.state();
  const waiting = waitForPage(host.state, before, 2000);
  await host.load();
  await waiting;
  assert.notEqual(host.state().messages[0]?.id, before.messages[0]?.id);
});

test("hits are marked case-insensitively", () => {
  assert.deepEqual(splitHighlight("The Lantern and the lantern", "LANTERN"), [
    { text: "The ", hit: false }, { text: "Lantern", hit: true }, { text: " and the ", hit: false }, { text: "lantern", hit: true },
  ]);
  assert.deepEqual(splitHighlight("银色的钥匙", "钥匙"), [{ text: "银色的", hit: false }, { text: "钥匙", hit: true }]);
  assert.deepEqual(splitHighlight("plain", ""), [{ text: "plain", hit: false }]);
});
