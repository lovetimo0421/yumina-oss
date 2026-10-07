import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { WorldDefinition, WorldEntry } from "@yumina/engine";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL("../../../..", import.meta.url)), appType: "custom", logLevel: "silent",
  resolve: { alias: { "@": fileURLToPath(new URL("../../..", import.meta.url)), "@yumina/engine": fileURLToPath(new URL("../../../../../engine/src/index.ts", import.meta.url)) } },
  esbuild: { jsx: "automatic" }, server: { middlewareMode: true },
});
const { useStudioPreviewChoices } = await vite.ssrLoadModule("/src/features/studio/panels/canvas-panel.tsx") as typeof import("./canvas-panel");
const { usePreviewVars } = await vite.ssrLoadModule("/src/features/editor/components/preview/live-frontend-preview.tsx") as typeof import("@/features/editor/components/preview/live-frontend-preview");
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("@/stores/editor");
const { useStudioSidebarStore } = await vite.ssrLoadModule("/src/stores/studio-sidebar.ts") as typeof import("@/stores/studio-sidebar");
after(async () => {
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

const opening = (id: string, hp: number, enabled = true): WorldEntry => ({ id, name: id, content: id, role: "greeting", section: "chat-history", position: 0, enabled, alwaysSend: false, keywords: [], conditions: [], conditionLogic: "all", initialVariables: { hp } });
const card = (id: string, entries: WorldEntry[]): WorldDefinition => ({ id, name: id, description: "", author: "", version: "1", settings: {}, entries, variables: [{ id: "hp", name: "Health", type: "number", defaultValue: 100 }], rules: [], components: [], audioTracks: [], customUI: [] });

async function withPreview(world: WorldDefinition, run: (context: {
  hp: () => number;
  select: (worldKey: string, id: string) => Promise<void>;
  replace: (world: WorldDefinition) => Promise<void>;
  explicit: (id?: string) => Promise<void>;
}) => Promise<void>) {
  useEditorStore.setState({ worldDraft: world, serverWorldId: null, isDirty: false, _past: [], _future: [] });
  useStudioSidebarStore.setState({ previewGreetingIdByWorld: {}, previewVariableOverridesByWorld: {} });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let explicitId: string | undefined;
  // Composed the way the Studio composes it: the renderer takes the choice as
  // an argument, the Studio is what remembers one per world. An explicit id
  // still wins, which is what the second test below is about.
  function Preview() {
    const { greetingId, overrides } = useStudioPreviewChoices();
    return createElement("output", null, JSON.stringify(usePreviewVars(explicitId ?? greetingId, overrides)));
  }
  const render = () => root.render(createElement(Preview));
  try {
    await act(async () => render());
    await run({
      hp: () => JSON.parse(dom.window.document.querySelector("output")!.textContent!).hp as number,
      select: async (worldKey, id) => { await act(async () => useStudioSidebarStore.getState().setPreviewGreetingId(worldKey, id)); },
      replace: async next => { await act(async () => useEditorStore.setState({ worldDraft: next })); },
      explicit: async id => { explicitId = id; await act(async () => render()); },
    });
  } finally {
    await act(async () => root.unmount());
    useEditorStore.getState().stopAutosave();
    dom.window.localStorage.clear();
  }
}

test("preview surfaces share the current card's opening while selections stay isolated across cards", async () => {
  const a = card("a", [opening("first", 10), opening("second", 20)]);
  const b = card("b", [opening("first", 50), opening("second", 60)]);
  await withPreview(a, async ({ hp, select, replace }) => {
    assert.equal(hp(), 10);
    await select("a", "second");
    assert.equal(hp(), 20, "the unparameterized player preview adopts the board's selection");
    await replace(b);
    assert.equal(hp(), 50, "an unselected card uses its own first opening");
    await select("b", "second");
    assert.equal(hp(), 60);
    await replace(a);
    assert.equal(hp(), 20);
    assert.deepEqual(useStudioSidebarStore.getState().previewGreetingIdByWorld, { a: "second", b: "second" });
    assert.equal(useEditorStore.getState().isDirty, false);
    assert.equal(useEditorStore.getState()._past.length, 0);
  });
});

test("explicit selections beat shared selections, and removed openings fall back without stale seeds", async () => {
  const world = card("a", [opening("draft", 5, false), opening("first", 10), opening("second", 20)]);
  await withPreview(world, async ({ hp, select, replace, explicit }) => {
    await select("a", "second");
    await explicit("draft");
    assert.equal(hp(), 5, "explicit disabled openings remain previewable");
    assert.equal(useStudioSidebarStore.getState().previewGreetingIdByWorld.a, "second");
    await explicit();
    assert.equal(hp(), 20);
    await replace({ ...world, entries: world.entries.filter(entry => entry.id !== "second") });
    assert.equal(hp(), 10, "deleting the shared selection falls back to an enabled opening");
    await replace({ ...world, entries: [] });
    assert.equal(hp(), 100, "without openings the preview returns to variable defaults");
  });
});

test("opening selections stay runtime-only while existing preview overrides remain persisted", async () => {
  await withPreview(card("a", [opening("first", 10), opening("second", 20)]), async ({ hp, select }) => {
    await act(async () => useStudioSidebarStore.getState().setPreviewVariableOverride("a", "hp", 30));
    await select("a", "second");
    assert.equal(hp(), 30, "temporary variable overrides keep precedence over the selected opening");
    const persisted = JSON.parse(dom.window.localStorage.getItem("yumina-studio-sidebar")!).state;
    assert.equal(Object.hasOwn(persisted, "previewGreetingIdByWorld"), false);
    assert.deepEqual(persisted.previewVariableOverridesByWorld, { a: { hp: 30 } });
    assert.ok(persisted.sectionVisibility);
  });
});
