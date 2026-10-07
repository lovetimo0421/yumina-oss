import assert from "node:assert/strict";
import test from "node:test";
import { getEditorMode, getGlobalEditorMode, saveEditorMode, saveGlobalEditorMode } from "./editor-mode";

function withStorage(impl: Partial<Storage>, run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: impl });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    store: data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  } as unknown as Storage & { store: Map<string, string> };
}

test("a card remembers its own editor, separately from other cards", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    saveEditorMode("world-a", "simple");
    saveEditorMode("world-b", "advanced");
    assert.equal(getEditorMode("world-a"), "simple");
    assert.equal(getEditorMode("world-b"), "advanced");
    // A card nobody has opened has no opinion — the caller falls back to the
    // global preference, then to advanced. See resolveEditorMode.
    assert.equal(getEditorMode("world-c"), null);
    saveEditorMode("world-a", "advanced");
    assert.equal(getEditorMode("world-a"), "advanced");
    assert.equal(getEditorMode("world-b"), "advanced");
  });
});

test("the global preference round-trips on its own key", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    assert.equal(getGlobalEditorMode(), null);
    saveGlobalEditorMode("simple");
    assert.equal(getGlobalEditorMode(), "simple");
    // Saving a card's mode must not disturb the global one, and vice versa —
    // the mode switch in the editor writes both, and a shared key would make
    // the last card opened redefine the default for every other card.
    saveEditorMode("world-a", "advanced");
    assert.equal(getGlobalEditorMode(), "simple");
    assert.equal(storage.store.size, 2);
  });
});

test("junk in storage is treated as no preference, not as a mode", () => {
  withStorage(memoryStorage({ "yumina-editor-mode": "not json" }), () => {
    assert.equal(getEditorMode("world-a"), null);
  });
  withStorage(memoryStorage({ "yumina-editor-mode": '{"world-a":"blueprint"}' }), () => {
    // An unknown value must not reach the router: it decides which component
    // renders, and anything but these two strings renders nothing.
    assert.equal(getEditorMode("world-a"), null);
  });
  withStorage(memoryStorage({ "yumina-editor-mode": '"a string"' }), () => {
    assert.equal(getEditorMode("world-a"), null);
  });
  withStorage(memoryStorage({ "yumina-editor-mode-global": "blueprint" }), () => {
    assert.equal(getGlobalEditorMode(), null);
  });
});

test("writing a card's mode keeps the other cards already stored", () => {
  const storage = memoryStorage({ "yumina-editor-mode": '{"world-a":"simple"}' });
  withStorage(storage, () => {
    saveEditorMode("world-b", "advanced");
    assert.deepEqual(JSON.parse(storage.store.get("yumina-editor-mode")!), { "world-a": "simple", "world-b": "advanced" });
  });
});

test("a browser that refuses storage still lets the editor open", () => {
  // Private windows and blocked site data throw on both read and write. None of
  // this is worth a crash on the way into someone's card.
  const throwing = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("SecurityError"); },
  } as unknown as Storage;
  withStorage(throwing, () => {
    assert.equal(getEditorMode("world-a"), null);
    assert.equal(getGlobalEditorMode(), null);
    assert.doesNotThrow(() => saveEditorMode("world-a", "simple"));
    assert.doesNotThrow(() => saveGlobalEditorMode("simple"));
  });
});
