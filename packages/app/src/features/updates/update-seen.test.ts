import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>([["yumina-updates-seen", JSON.stringify({ date: "2026-10-01", ids: ["old"] })]]);
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
};
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ latest: { id: "fresh", date: "2026-10-13" } }), { status: 200 })) as typeof fetch;

const { isUnseen, markLatestSeen, markerBeforeOpen } = await import("./update-seen");

test("the bell's click marks the newest entry seen and hands the old marker to the page", async () => {
  markLatestSeen("en");
  await new Promise((r) => setTimeout(r, 0));

  const saved = JSON.parse(store.get("yumina-updates-seen")!);
  assert.deepEqual(saved, { date: "2026-10-13", ids: ["fresh"] });

  const before = markerBeforeOpen(saved);
  assert.deepEqual(before, { date: "2026-10-01", ids: ["old"] });
  assert.equal(isUnseen({ id: "fresh", date: "2026-10-13" }, before), true);
});
