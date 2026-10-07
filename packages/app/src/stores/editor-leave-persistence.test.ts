import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach, beforeEach } from "node:test";
import { createServer } from "vite";

/**
 * Leaving the editor must not leave persistence running behind it.
 *
 * The route's unmount cleanup calls stopAutosave, and only then do its
 * children unmount. A debounced field still holding typed text commits it as
 * it goes — and that commit used to restart the 60s server autosave and queue
 * a local recovery write, for a card nobody had open any more.
 */

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} });
const listeners = new Map<string, Set<() => void>>();
const fakeWindow = {
  addEventListener: (type: string, fn: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
  removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
  dispatchEvent: (event: Event) => { for (const fn of listeners.get(event.type) ?? []) fn(); return true; },
};
const hadWindow = "window" in globalThis;

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = await createServer({
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
});
const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const { FLUSH_PENDING_EDITS_EVENT } = await vite.ssrLoadModule("/src/features/editor/components/flush-pending-edits.ts") as typeof import("../features/editor/components/flush-pending-edits");
const initial = structuredClone(store.getState().worldDraft);
// Only now: the modules above read window.location when a window exists.
if (!hadWindow) Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
/** Intervals started and not yet cleared. */
const live = new Set<unknown>();
beforeEach(() => {
  memory.clear();
  live.clear();
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    live.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    live.delete(handle);
    realClearInterval(handle);
  }) as typeof clearInterval;
  globalThis.fetch = (async (url: unknown) => { throw new Error(`Unexpected network request: ${url}`); }) as typeof fetch;
  store.setState({ worldDraft: structuredClone(initial), serverWorldId: "card", isDirty: false, layoutDirty: false, saving: false, guestMode: false, readOnlyInspect: false, _past: [], _future: [] });
});
afterEach(() => {
  store.getState().stopAutosave();
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});
after(async () => {
  await vite.close();
  if (!hadWindow) Reflect.deleteProperty(globalThis, "window");
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a field that commits while the editor unmounts starts no autosave and writes no recovery draft", async () => {
  // Stand-in for a DebouncedField: it holds text and commits it on unmount.
  let pending: string | null = "typed just before leaving";
  const commit = () => {
    if (pending === null) return;
    const text = pending;
    pending = null;
    store.getState().setSettings("playerName", text);
  };
  window.addEventListener(FLUSH_PENDING_EDITS_EVENT, commit);

  // Route cleanup first …
  store.getState().stopAutosave();
  // … then the children unmount and flush.
  window.removeEventListener(FLUSH_PENDING_EDITS_EVENT, commit);
  commit();

  assert.equal(store.getState().worldDraft.settings.playerName, "typed just before leaving", "the text is not lost");
  assert.equal(live.size, 0, "no server autosave was restarted after leaving");
  await settle(2600);
  assert.equal(memory.has("yumina-editor-draft"), false, "no recovery draft was written after leaving");
});

test("editing after the editor is opened again persists as usual", async () => {
  store.getState().stopAutosave();
  await settle(5);
  store.getState().setSettings("playerName", "back again");
  assert.equal(live.size, 1, "the first edit starts the server autosave");
});
