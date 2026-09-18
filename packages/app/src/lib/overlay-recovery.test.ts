import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installOverlayRecovery } from "./overlay-recovery";

function harness(t: test.TestContext) {
  const dom = new JSDOM("<main>Feed</main>", { pretendToBeVisual: true });
  const win = dom.window;
  const timers = new Map<number, () => void>();
  let nextId = 0;
  let recoveries = 0;
  win.setTimeout = ((callback: () => void) => { timers.set(++nextId, callback); return nextId; }) as typeof win.setTimeout;
  win.clearTimeout = (id) => { if (id !== undefined) timers.delete(id); };
  const cleanup = installOverlayRecovery(win as unknown as Window, () => { recoveries++; });
  t.after(() => { cleanup(); dom.window.close(); });
  return {
    win, body: win.document.body, cleanup,
    get recoveries() { return recoveries; },
    lock() { win.document.body.style.pointerEvents = "none"; win.document.body.setAttribute("data-scroll-locked", "1"); },
    async settle() {
      await Promise.resolve(); // deliver MutationObserver records
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
      await Promise.resolve();
    },
  };
}

test("returning to the same page clears orphaned locks without navigating", async (t) => {
  const h = harness(t);
  await h.settle();
  h.lock();
  h.win.document.dispatchEvent(new h.win.Event("visibilitychange"));
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  await h.settle();
  assert.equal(h.body.style.pointerEvents, "");
  assert.equal(h.body.hasAttribute("data-scroll-locked"), false);
  assert.equal(h.recoveries, 1);
});

test("closing a menu on the same route cannot leave the page untappable", async (t) => {
  const h = harness(t);
  h.body.insertAdjacentHTML("beforeend", '<div data-radix-popper-content-wrapper><div role="menu" data-state="open"></div></div>');
  h.lock();
  await h.settle();
  assert.equal(h.body.style.pointerEvents, "none");
  h.body.querySelector('[role="menu"]')!.setAttribute("data-state", "closed");
  await h.settle();
  assert.equal(h.body.style.pointerEvents, "");
});

test("live nested dialogs retain their pointer and scroll locks", async (t) => {
  const h = harness(t);
  h.body.insertAdjacentHTML("beforeend", '<div role="dialog" data-state="open"><div role="alertdialog" data-state="open"></div></div>');
  h.lock();
  await h.settle();
  h.body.querySelector('[role="alertdialog"]')!.remove();
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  await h.settle();
  assert.equal(h.body.style.pointerEvents, "none");
  assert.equal(h.body.hasAttribute("data-scroll-locked"), true);
  assert.equal(h.recoveries, 0);
});

test("a live custom dialog without Radix data-state also retains its locks", async (t) => {
  const h = harness(t);
  h.body.insertAdjacentHTML("beforeend", '<div role="dialog" aria-modal="true"></div>');
  h.lock();
  await h.settle();
  assert.equal(h.body.style.pointerEvents, "none");
});

test("cleanup cancels recovery and removes observers and resume listeners", async (t) => {
  const h = harness(t);
  h.cleanup();
  h.lock();
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  await h.settle();
  assert.equal(h.body.style.pointerEvents, "none");
  assert.equal(h.recoveries, 0);
});

test("the permanently mounted mobile drawer only protects locks while open", async (t) => {
  const h = harness(t);
  h.body.insertAdjacentHTML("beforeend", '<aside role="dialog" aria-modal="true" aria-hidden="false"></aside>');
  h.lock();
  await h.settle();
  assert.equal(h.body.style.pointerEvents, "none");
  const drawer = h.body.querySelector("aside")!;
  drawer.setAttribute("aria-hidden", "true");
  drawer.setAttribute("inert", "");
  await h.settle();
  assert.equal(h.body.style.pointerEvents, "");
});
