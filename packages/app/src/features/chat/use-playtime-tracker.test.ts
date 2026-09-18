import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("a late parent tick cannot pause a branch or restart a hidden tracker", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test", pretendToBeVisual: true });
  const requests: Array<{ session: string; event: string; recoverElapsed?: boolean; resolve: (value: unknown) => void }> = [];
  const timers = new Map<number, { callback: () => unknown; delay: number }>();
  let nextTimer = 1;
  dom.window.setInterval = ((callback: () => unknown, delay: number) => {
    const id = nextTimer++;
    timers.set(id, { callback, delay });
    return id;
  }) as typeof dom.window.setInterval;
  dom.window.clearInterval = (id: number) => { timers.delete(id); };
  const globals = {
    window: dom.window, document: dom.window.document,
    navigator: { sendBeacon: () => true }, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string, options: RequestInit) => new Promise(resolve => {
      const { event, recoverElapsed } = JSON.parse(options.body as string);
      requests.push({ session: url.split("/").at(-2)!, event, recoverElapsed, resolve });
    }),
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const source = readFileSync(new URL("./use-playtime-tracker.ts", import.meta.url), "utf8").replace('import.meta.env.VITE_API_URL', '""');
  const module = { exports: {} as { usePlaytimeTracker: (id: string, enabled: boolean) => { status: string } } };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)(
    (id: string) => id === "./play-interaction" ? { hasRecentPlayInteraction: () => false } : require(id), module, module.exports,
  );
  let state = { status: "idle" };
  const Probe = ({ id, enabled }: { id: string; enabled: boolean }) => {
    state = module.exports.usePlaytimeTracker(id, enabled);
    return null;
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (id: string, enabled = true) => act(async () => { root.render(createElement(Probe, { id, enabled })); });
  const resolve = (request: typeof requests[number], active: boolean) => act(async () => {
    request.resolve({ ok: true, json: async () => ({ data: { accepted: active, active } }) });
  });
  const tick = () => act(async () => { for (const timer of [...timers.values()]) if (timer.delay === 15_000) void timer.callback(); });
  try {
    await render("parent");
    assert.equal(requests.at(-1)!.recoverElapsed, false);
    await resolve(requests.find(r => r.session === "parent" && r.event === "resume")!, true);
    await tick();
    const parentTick = requests.find(r => r.session === "parent" && r.event === "tick")!;
    await render("branch");
    await resolve(requests.find(r => r.session === "branch" && r.event === "resume")!, true);
    assert.equal(state.status, "active");
    await resolve(parentTick, false);
    assert.equal(state.status, "active", "old session response must not change the new lease");
    await tick();
    const branchTick = requests.find(r => r.session === "branch" && r.event === "tick")!;
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await resolve(branchTick, true);
    assert.equal(state.status, "paused", "late tick must not revive a hidden tracker");
    assert.equal([...timers.values()].filter(t => t.delay === 15_000).length, 0);
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    assert.equal(requests.at(-1)!.recoverElapsed, false, "visibility restore cannot assume the pause reached the server");
    await resolve(requests.at(-1)!, false);
    await act(async () => { for (const timer of [...timers.values()]) if (timer.delay === 5_000) void timer.callback(); });
    assert.equal(requests.at(-1)!.recoverElapsed, false, "a lost restoration request cannot restore continuity");
    await resolve(requests.at(-1)!, true);
    await act(async () => dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide", { persisted: true })));
    const beforeRestore = requests.length;
    await act(async () => dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pageshow", { persisted: true })));
    assert.equal(requests.length, beforeRestore + 1, "restoring the page must reacquire the stopped lease");
    assert.equal(requests.at(-1)!.recoverElapsed, false);
    await resolve(requests.at(-1)!, true);
    assert.equal(state.status, "active");
    await tick();
    await resolve(requests.at(-1)!, false);
    assert.equal(requests.at(-1)!.event, "resume");
    assert.equal(requests.at(-1)!.recoverElapsed, true, "a failed tick in continuous play preserves elapsed time");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
