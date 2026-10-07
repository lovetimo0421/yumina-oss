import test from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { sessionStorage?: Storage }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { consumeQuietTour, quietTourRequested, requestInterfaceEditor, requestQuietTour, takeRequestedPanel } = await import("./studio-entry");
const tick = () => new Promise((r) => setTimeout(r, 5));

test("a request opens Studio on the interface editor, quietly", async () => {
  requestInterfaceEditor();
  // Read twice in the same tick (React runs a mount twice): both see it.
  assert.equal(takeRequestedPanel((p) => p === "frontend"), "frontend");
  assert.equal(takeRequestedPanel((p) => p === "frontend"), "frontend");
  assert.equal(consumeQuietTour(), true);
  assert.equal(consumeQuietTour(), true);
  await tick();
  // …and it is gone by the next visit.
  assert.equal(takeRequestedPanel(() => true), null);
  assert.equal(consumeQuietTour(), false);
});

test("reading the quiet note leaves it for the mount that commits; a template asks for quiet alone", async () => {
  requestQuietTour();
  assert.equal(quietTourRequested(), true);
  await tick();
  // A render that read it and was thrown away took nothing with it.
  assert.equal(quietTourRequested(), true);
  assert.equal(takeRequestedPanel(() => true), null, "a template opens on the board, not a panel");
  assert.equal(consumeQuietTour(), true);
  await tick();
  assert.equal(quietTourRequested(), false);
});

test("a panel the shell does not have is left for another shell", async () => {
  requestInterfaceEditor();
  assert.equal(takeRequestedPanel((p) => p === "lorebook"), null);
  assert.equal(takeRequestedPanel((p) => p === "frontend"), "frontend");
  await tick();
});
