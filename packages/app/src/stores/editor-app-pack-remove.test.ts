import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";

// A creator added the Adventure / RPG starter set (four in-story apps), then
// tried to get rid of it by deleting the apps' variables one by one. The dock
// buttons stayed, so they rebuilt the whole card on a new one. The apps page
// now removes an app through its install record; that has to clear the card
// even after its variables were already deleted by hand.

const memory = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
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
const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const engine = await vite.ssrLoadModule("/@fs/" + fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url))) as typeof import("@yumina/engine");
const initial = structuredClone(store.getState().worldDraft);

beforeEach(() => {
  store.setState({ worldDraft: structuredClone(initial), serverWorldId: null, isDirty: false, _past: [], _future: [] });
});
after(async () => {
  store.getState().stopAutosave();
  await vite.close();
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const starterSet = () => engine.appPackSets("en")[0]!.packs;
const appFiles = () => Object.keys(store.getState().worldDraft.rootComponent?.files ?? {}).filter((path) => path.startsWith("_bundles/"));

function installSet() {
  for (const id of starterSet()) store.getState().importBundle(engine.appPack(id, "en"));
  assert.equal(store.getState().worldDraft.installedBundles?.length, starterSet().length);
  assert.ok(appFiles().length > 0, "the apps brought their screens");
}

function removeThroughRecords() {
  for (const record of [...(store.getState().worldDraft.installedBundles ?? [])]) {
    store.getState().removeInstalledBundle(record.installId);
  }
}

test("removing the apps takes their screens, data and dock entry off the card", () => {
  installSet();
  removeThroughRecords();
  const draft = store.getState().worldDraft;
  assert.deepEqual(draft.installedBundles ?? [], []);
  assert.deepEqual(appFiles(), []);
  for (const id of starterSet()) {
    assert.ok(!draft.variables.some((v) => v.id === engine.appPackVariableId(id)), `${id}'s data is gone`);
    assert.ok(!(draft.rootComponent?.files["index.tsx"] ?? "").includes(`_bundles/${id}/`), `${id} is out of the dock`);
  }
});

test("a card whose app variables were already deleted by hand can still be cleared", () => {
  installSet();
  for (const id of starterSet()) {
    const index = store.getState().worldDraft.variables.findIndex((v) => v.id === engine.appPackVariableId(id));
    if (index >= 0) store.getState().removeVariableAt(index);
  }
  assert.ok(appFiles().length > 0, "deleting the variables alone left the apps on the card (the reported bug)");
  removeThroughRecords();
  assert.deepEqual(appFiles(), []);
  assert.deepEqual(store.getState().worldDraft.installedBundles ?? [], []);
});
