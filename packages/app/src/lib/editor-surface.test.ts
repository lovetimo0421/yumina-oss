import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import {
  getEditorSurface,
  saveEditorSurface,
  shouldOpenVisual,
  type SurfaceDecision,
} from "./editor-surface";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
});

const base: SurfaceDecision = { mode: "advanced", last: null, allowed: true, guest: false };

test("a creator who has never chosen lands on the 完整 editor (the canvas is a beta)", () => {
  assert.equal(shouldOpenVisual(base), false);
});

test("the switch is where they left it", () => {
  assert.equal(shouldOpenVisual({ ...base, last: "visual" }), true);
  assert.equal(shouldOpenVisual({ ...base, last: "classic" }), false);
});

test("simple mode is its own editor and is left alone", () => {
  assert.equal(shouldOpenVisual({ ...base, mode: "simple" }), false);
  assert.equal(shouldOpenVisual({ ...base, mode: "simple", last: "visual" }), false);
});

test("a closed blueprint and a signed-out draft never redirect", () => {
  assert.equal(shouldOpenVisual({ ...base, allowed: false }), false);
  assert.equal(shouldOpenVisual({ ...base, guest: true }), false);
});

test("the remembered surface round-trips, and junk reads as no choice", () => {
  assert.equal(getEditorSurface(), null);
  saveEditorSurface("classic");
  assert.equal(getEditorSurface(), "classic");
  saveEditorSurface("visual");
  assert.equal(getEditorSurface(), "visual");
  localStorage.setItem("yumina-editor-surface", "sideways");
  assert.equal(getEditorSurface(), null);
});

test("a browser that refuses to remember still opens the card", () => {
  const hostile = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  } as unknown as Storage;
  (globalThis as { localStorage?: Storage }).localStorage = hostile;
  assert.equal(getEditorSurface(), null);
  assert.doesNotThrow(() => saveEditorSurface("visual"));
});
