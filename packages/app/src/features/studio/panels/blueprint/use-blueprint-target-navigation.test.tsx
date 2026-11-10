import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { useAutomaticBlueprintFit, useInitialBlueprintFit } from "./use-initial-blueprint-fit";
import { useBlueprintTargetNavigation, waitForMeasuredBlueprintTarget, type BlueprintTargetBounds, type BlueprintTargetRequest } from "./use-blueprint-target-navigation";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
  cancelAnimationFrame: (id: number) => { frames.delete(id); } };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
afterEach(() => frames.clear());
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});
async function frame() { await act(async () => { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(performance.now()); }); }

test("slow module measurements still establish an entrance, but never override a manual visit", async () => {
  let now = 0;
  const realNow = performance.now;
  performance.now = () => now;
  let fitCalls = 0;
  let cancel = () => {};
  let settled = () => false;
  const getNodes = () => [{ measured: { height: 0 } }];
  const fit = () => { fitCalls++; return true; };
  function Harness() {
    const initial = useInitialBlueprintFit({ writing: false, worldId: "slow", ready: true, viewportReady: true,
      nodeCount: 1, getNodes, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: () => true, fit });
    cancel = initial.cancelInitialFit; settled = initial.isViewportSettled;
    return null;
  }
  let root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    now = 1000; await frame();
    assert.equal(fitCalls, 1, "measurement timeout must fit available frame bounds instead of retaining the default camera");
    assert.equal(settled(), true);
    await act(async () => root.unmount()); frames.clear();
    root = createRoot(dom.window.document.getElementById("root")!);
    now = 0;
    await act(async () => root.render(createElement(Harness)));
    cancel(); now = 1000; await frame();
    assert.equal(fitCalls, 1, "manual pan/zoom takes ownership before the delayed fit");
    assert.equal(settled(), true, "explicit object navigation remains unblocked");
  } finally { await act(async () => root.unmount()); performance.now = realNow; }
});


test("a global object handoff waits for mounting, node measurements and completion of the initial viewport", async () => {
  let writing = true;
  let viewportReady = false;
  let request: BlueprintTargetRequest | null = null;
  let nodes: { measured?: { height: number } }[] = [];
  let finishFit: (() => void) | undefined;
  let fitCalls = 0;
  const navigated: string[] = [];
  const getNodes = () => nodes;
  const getViewport = () => ({ x: 0, y: 0, zoom: 1 });
  const setViewport = () => true;
  const fit = () => { fitCalls++; return new Promise<boolean>(resolve => { finishFit = () => resolve(true); }); };
  function Harness() {
    const { isViewportSettled } = useInitialBlueprintFit({ writing, worldId: "card", ready: true, viewportReady, nodeCount: 1, getNodes, getViewport, setViewport, fit });
    useBlueprintTargetNavigation({ request, documentKey: "card", active: !writing, viewportReady, isViewportSettled,
      navigate: id => navigated.push(id), onComplete: () => { request = null; } });
    return createElement("div");
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async () => { await act(async () => root.render(createElement(Harness))); };
  try {
    await render();
    request = { objectId: "var:health", documentKey: "card", sequence: 1 };
    writing = false; await render(); await frame();
    assert.equal(fitCalls, 0); assert.deepEqual(navigated, []);
    viewportReady = true; await render(); await frame();
    assert.equal(fitCalls, 0); assert.deepEqual(navigated, []);
    nodes = [{ measured: { height: 200 } }]; await frame();
    assert.equal(fitCalls, 1); assert.deepEqual(navigated, [], "an unfinished fit must not overwrite a later object jump");
    await act(async () => finishFit!()); await frame();
    assert.deepEqual(navigated, ["var:health"]);
    await frame(); assert.equal(navigated.length, 1);
  } finally { await act(async () => root.unmount()); }
});

test("returning to creation or switching cards cancels a pending global handoff, and the latest request wins", async () => {
  let active = true;
  let settled = false;
  let documentKey = "card-a";
  let request: BlueprintTargetRequest | null = { objectId: "entry:a", documentKey, sequence: 1 };
  const navigated: string[] = [];
  const isViewportSettled = () => settled;
  function Harness() {
    useBlueprintTargetNavigation({ request, documentKey, active, viewportReady: true, isViewportSettled,
      navigate: id => navigated.push(id), onComplete: () => { request = null; } });
    return createElement("div");
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async () => { await act(async () => root.render(createElement(Harness))); };
  try {
    await render(); await frame();
    active = false; await render(); settled = true; await frame();
    assert.deepEqual(navigated, []);
    active = true; documentKey = "card-b"; await render(); await frame();
    assert.deepEqual(navigated, [], "an old card request cannot navigate its replacement");
    settled = false;
    request = { objectId: "var:old", documentKey, sequence: 2 }; await render(); await frame();
    request = { objectId: "var:latest", documentKey, sequence: 3 }; await render();
    settled = true; await frame();
    assert.deepEqual(navigated, ["var:latest"]);
  } finally { await act(async () => root.unmount()); }
});

test("repeated object visits after viewport restoration survive delayed inspector resize and row expansion fits", async () => {
  let writing = false;
  let request: BlueprintTargetRequest | null = null;
  let selection: string | null = null;
  let viewport = { x: 10, y: 20, zoom: 0.3 };
  let fitCalls = 0;
  let restoreCalls = 0;
  let rememberViewport = () => {};
  let automaticFit: (duration?: number) => unknown = () => {};
  const navigated: string[] = [];
  const getNodes = () => [{ measured: { height: 200 } }];
  const getViewport = () => viewport;
  const setViewport = (next: typeof viewport) => { restoreCalls++; viewport = next; return true; };
  const fit = () => { fitCalls++; viewport = { x: 10, y: 20, zoom: 0.3 }; return true; };
  function Harness() {
    const initial = useInitialBlueprintFit({ writing, worldId: "card", ready: true, viewportReady: true, nodeCount: 1, getNodes, getViewport, setViewport, fit });
    rememberViewport = initial.rememberViewport;
    automaticFit = useAutomaticBlueprintFit({ blocked: writing || selection !== null || request !== null, fit });
    useBlueprintTargetNavigation({ request, documentKey: "card", active: !writing, viewportReady: true, isViewportSettled: initial.isViewportSettled,
      navigate: id => {
        selection = id;
        navigated.push(id);
        viewport = { x: 100, y: 200, zoom: 0.9 };
      }, onComplete: () => { request = null; } });
    return createElement("div");
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async () => { await act(async () => root.render(createElement(Harness))); };
  try {
    await render(); await frame();
    assert.equal(fitCalls, 1);
    // Resize/reflow work can already have captured its callback when the
    // author leaves the overview. It must read the current visit at execution.
    const delayedResizeFit = automaticFit;
    for (const [index, objectId] of ["var:hp", "var:corrosion"].entries()) {
      rememberViewport();
      writing = true; selection = null; await render();
      viewport = { x: 0, y: 0, zoom: 1 }; // ReactFlow unmount resets its store.
      request = { objectId, documentKey: "card", sequence: index + 1 };
      writing = false; await render();
      delayedResizeFit(320);
      assert.equal(fitCalls, 1, "a pending handoff owns the viewport before selection mounts");
      await frame(); await frame(); await render();
      assert.equal(selection, objectId);
      assert.equal(request, null);
      assert.equal(viewport.zoom, 0.9);
      delayedResizeFit(320); automaticFit(320);
      assert.equal(viewport.zoom, 0.9, "opening the inspector or expanding its target must not zoom back out");
    }
    assert.deepEqual(navigated, ["var:hp", "var:corrosion"]);
    assert.equal(restoreCalls, 2);
    assert.equal(fitCalls, 1);
    selection = null; await render();
    automaticFit(320);
    assert.equal(fitCalls, 2, "an unselected overview still adapts to actual size changes");
  } finally { await act(async () => root.unmount()); }
});

test("a collapsed target is centered only after its real bounds exist, and cancelled targets never move the viewport", async () => {
  let target: BlueprintTargetBounds | undefined;
  const centers: BlueprintTargetBounds[] = [];
  const cancel = waitForMeasuredBlueprintTarget({ getTarget: () => target, isCurrent: () => true, onReady: bounds => centers.push(bounds) });
  await frame(); assert.equal(centers.length, 0);
  target = { x: 300, y: 800, width: 0, height: 0 }; await frame(); assert.equal(centers.length, 0);
  target = { x: 300, y: 800, width: 400, height: 200 }; await frame(); assert.deepEqual(centers, [target]);
  cancel();
  target = undefined;
  const cancelNext = waitForMeasuredBlueprintTarget({ getTarget: () => target, isCurrent: () => true, onReady: bounds => centers.push(bounds) });
  cancelNext(); target = { x: 10, y: 20, width: 30, height: 40 }; await frame();
  assert.equal(centers.length, 1);
});
