import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import type { UiDoc, WorldDefinition } from "@yumina/engine";

/**
 * A card's interface is compiled from its document when it is edited and
 * saved. Opening a card the compiler has improved on since its last save
 * builds it again: the board shows the new build at once, and running or
 * publishing the card saves it first, so nobody plays the old one.
 */

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} });
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = await createServer({
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
});
const editor = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const engine = await vite.ssrLoadModule("@yumina/engine") as typeof import("@yumina/engine");
const store = editor.useEditorStore;

beforeEach(() => {
  globalThis.fetch = async (url: unknown) => { throw new Error(`Unexpected network request: ${url}`); };
  memory.clear();
});
after(async () => { await vite.close(); });

const doc: UiDoc = {
  version: 1,
  entryPageId: "p",
  pages: [{
    id: "p",
    name: "Chat",
    height: 812,
    elements: [
      // A wide box that only repeats the phone one: what older edits wrote.
      { id: "m", type: "messages", name: "Transcript", x: 0, y: 96, w: 375, h: 608, desktop: { x: 0, y: 144, w: 375, h: 560 } },
      { id: "c", type: "composer", name: "Input", x: 0, y: 716, w: 375, h: 96 },
    ],
  }],
} as UiDoc;

const open = (rootComponent: WorldDefinition["rootComponent"]) => store.getState().loadWorldFromData({
  id: "w1",
  name: "Card",
  description: null,
  thumbnailUrl: null,
  schema: { id: "w1", name: "Card", uiDoc: doc, rootComponent } as unknown as Record<string, unknown>,
});
const debounce = () => new Promise((resolve) => setTimeout(resolve, 700));

test("an interface built by an older compiler is built again on open, without dirtying the card", async () => {
  open({ id: "r", name: "Interface", entryFile: "index.tsx", files: { "index.tsx": "// the old build" }, updatedAt: "2026-10-01T00:00:00.000Z", generatedFrom: "uiDoc" });
  assert.equal(editor.generatedInterfaceUnsaved(store.getState()), false, "nothing has been rebuilt yet");
  await debounce();
  const state = store.getState();
  assert.notEqual(state.worldDraft.rootComponent?.files["index.tsx"], "// the old build");
  assert.equal(state.isDirty, false, "opening a card is not an edit");
  assert.equal(editor.generatedInterfaceUnsaved(state), true, "a run or a publish has to save the new build");
});

test("an interface the current compiler already built is left as it is", async () => {
  const built = engine.compileUiDoc(doc);
  open({ id: "r", name: "Interface", entryFile: built.entryFile, files: built.files, updatedAt: "2026-10-01T00:00:00.000Z", generatedFrom: "uiDoc" });
  await debounce();
  assert.equal(editor.generatedInterfaceUnsaved(store.getState()), false);
});

test("a hand-written interface is never rebuilt", async () => {
  open({ id: "r", name: "Interface", entryFile: "index.tsx", files: { "index.tsx": "export default () => null" }, updatedAt: "2026-10-01T00:00:00.000Z" });
  await debounce();
  assert.equal(store.getState().worldDraft.rootComponent?.files["index.tsx"], "export default () => null");
  assert.equal(editor.generatedInterfaceUnsaved(store.getState()), false);
});
