import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import type { YuminaBundle } from "@yumina/engine";

// Resource packs, step 2: a pack can go into a situation, replace the card's
// screen or leave its interface behind, carry its asset references over to the
// card's copies, settle same-name variables one by one, and bring a settings
// form that writes into the variables as installed.

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
const editor = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const engine = await vite.ssrLoadModule("/@fs/" + fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url))) as typeof import("@yumina/engine");
const store = editor.useEditorStore;
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

const OLD_ASSET = "11111111-2222-3333-4444-555555555555";
const NEW_ASSET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function pack(overrides: Partial<YuminaBundle> = {}): YuminaBundle {
  return {
    bundleVersion: "3.0.0",
    name: "Phone",
    description: "",
    tags: [],
    createdAt: "2026-10-28T00:00:00.000Z",
    entries: [
      { id: "e-lore", name: "How the phone works", content: `Icon: @asset:${OLD_ASSET}`, role: "system", keywords: [], enabled: true, position: 0 } as never,
      { id: "e-hi", name: "Hello", content: "Hi", role: "greeting", keywords: [], enabled: true, position: 1 } as never,
    ],
    variables: [
      { id: "phone", name: "phone", type: "json", defaultValue: { voice: { id: "" } } } as never,
      { id: "mood", name: "Mood", type: "number", defaultValue: 0 } as never,
    ],
    rules: [],
    reactions: [{ id: "r1", name: "ring", when: { kind: "turn" }, conditions: [], conditionLogic: "all", then: [] } as never],
    audioTracks: [],
    rootComponent: {
      id: "pack:root", name: "Root", entryFile: "index.tsx", updatedAt: "",
      files: { "index.tsx": `export default function Phone() { const api = useYumina(); return <img src="@asset:${OLD_ASSET}" title={String(api.variables.mood)} data-k="mood" />; }` },
    },
    settings: [{ id: "voice", label: "Voice", type: "text", variableId: "phone", path: "voice.id" }],
    version: 3,
    ...overrides,
  };
}

const world = () => {
  const w = editor.createEmptyWorld();
  w.worldbooks = [{ id: "wb-dungeon", name: "Dungeon", activation: { mode: "always" } } as never];
  w.variables = [{ id: "mood-card", name: "mood", type: "number", defaultValue: 5 } as never];
  return w;
};

test("by default the pack composes beside the card's screen, as before", () => {
  const out = editor.mergeBundleIntoWorld(world(), pack(), "hub-1");
  const record = out.installedBundles!.at(-1)!;
  assert.equal(record.slug, "phone");
  assert.equal(record.previousRoot, undefined);
  assert.equal(record.version, 3);
  assert.deepEqual(engine.readComposedLayout(out.rootComponent!.files["index.tsx"]), {});
  assert.ok(out.rootComponent!.files["_bundles/phone/index.tsx"]);
  assert.ok(out.rootComponent!.files[engine.USER_ROOT_PATH]);
});

test("into a situation: the pack's unscoped entries and behaviours belong to it; the opening stays the card's", () => {
  const out = editor.mergeBundleIntoWorld(world(), pack(), undefined, { worldbookId: "wb-dungeon" });
  const record = out.installedBundles!.at(-1)!;
  assert.equal(record.worldbookId, "wb-dungeon");
  const lore = out.entries.find((e) => e.name === "How the phone works")!;
  const hello = out.entries.find((e) => e.name === "Hello")!;
  assert.equal(lore.worldbookId, "wb-dungeon");
  assert.equal(hello.worldbookId, undefined);
  assert.equal(out.reactions!.find((r) => r.name === "ring")!.worldbookId, "wb-dungeon");
  // A situation that is not on the card is ignored.
  const nowhere = editor.mergeBundleIntoWorld(world(), pack(), undefined, { worldbookId: "missing" });
  assert.equal(nowhere.entries.find((e) => e.name === "How the phone works")!.worldbookId, undefined);
});

test("replace: the pack's screen is mounted instead of the author's, which stays a file; uninstalling puts it back", () => {
  const w = world();
  w.rootComponent = { id: "r", name: "Root", entryFile: "index.tsx", updatedAt: "", files: { "index.tsx": "export default function Mine() { return <Chat />; }" } };
  store.setState({ worldDraft: w });
  const installId = store.getState().importBundle(pack(), undefined, { interface: "replace" })!;
  let files = store.getState().worldDraft.rootComponent!.files;
  assert.deepEqual(engine.readComposedLayout(files["index.tsx"]), { screen: "phone" });
  assert.equal(files[engine.USER_ROOT_PATH], "export default function Mine() { return <Chat />; }");
  assert.deepEqual(store.getState().worldDraft.installedBundles!.at(-1)!.previousRoot, {});

  // A second pack replacing the screen parks the first; removing the second
  // hands the screen back to the first.
  const second = store.getState().importBundle(pack({ name: "Map" }), undefined, { interface: "replace" })!;
  files = store.getState().worldDraft.rootComponent!.files;
  assert.deepEqual(engine.readComposedLayout(files["index.tsx"]), { screen: "map", parked: ["phone"] });
  store.getState().removeInstalledBundle(second);
  files = store.getState().worldDraft.rootComponent!.files;
  assert.deepEqual(engine.readComposedLayout(files["index.tsx"]), { screen: "phone" });
  store.getState().removeInstalledBundle(installId);
  files = store.getState().worldDraft.rootComponent!.files;
  assert.deepEqual(engine.readComposedLayout(files["index.tsx"]), {});
  assert.ok(files["index.tsx"]!.includes("<UserRoot />"));
});

test("skip: the pack's interface is not taken", () => {
  const out = editor.mergeBundleIntoWorld(world(), pack(), undefined, { interface: "skip" });
  assert.equal(out.installedBundles!.at(-1)!.slug, undefined);
  assert.ok(!Object.keys(out.rootComponent?.files ?? {}).some((f) => f.startsWith("_bundles/")));
  assert.equal(out.entries.filter((e) => e.bundleInstallId).length, 2);
});

test("assetMap rewrites the pack's asset references everywhere and is recorded", () => {
  const out = editor.mergeBundleIntoWorld(world(), pack(), undefined, { assetMap: { [OLD_ASSET]: NEW_ASSET } });
  assert.ok(out.entries.find((e) => e.name === "How the phone works")!.content.includes(`@asset:${NEW_ASSET}`));
  assert.ok(out.rootComponent!.files["_bundles/phone/index.tsx"]!.includes(`@asset:${NEW_ASSET}`));
  assert.ok(!JSON.stringify(out).includes(`@asset:${OLD_ASSET}`));
  assert.deepEqual(out.installedBundles!.at(-1)!.assetMap, { [OLD_ASSET]: NEW_ASSET });
});

test("a same-name variable: merge into the card's, or keep both under a chosen name", () => {
  const merged = editor.mergeBundleIntoWorld(world(), pack(), undefined, { variableConflicts: { mood: { mode: "merge" } } });
  assert.equal(merged.variables.filter((v) => v.name.toLowerCase() === "mood").length, 1);
  assert.ok(!merged.installedBundles!.at(-1)!.variableIds.includes("mood"));
  const code = merged.rootComponent!.files["_bundles/phone/index.tsx"]!;
  assert.ok(code.includes(`api.variables["mood-card"]`), "the interface reads the card's variable");
  assert.ok(code.includes(`data-k="mood-card"`));

  const kept = editor.mergeBundleIntoWorld(world(), pack(), undefined, { variableConflicts: { mood: { mode: "keep", name: "Phone mood" } } });
  const mine = kept.variables.find((v) => v.name === "Phone mood")!;
  assert.ok(mine);
  assert.ok(kept.installedBundles!.at(-1)!.variableIds.includes(mine.id));

  // Without a choice: the old "(1)" rename.
  const old = editor.mergeBundleIntoWorld(world(), pack());
  assert.ok(old.variables.some((v) => v.name === "Mood (1)"));
});

test("a pack's variable can be pointed at one of the card's with another name", () => {
  const w = world();
  w.variables.push({ id: "heart", name: "Affection", type: "number", defaultValue: 10 } as never);
  const linked = editor.mergeBundleIntoWorld(w, pack({ variables: [{ id: "love", name: "Love", type: "number", defaultValue: 0 } as never] }), undefined, {
    variableConflicts: { love: { mode: "merge", targetId: "heart" } },
  });
  assert.ok(!linked.variables.some((v) => v.id === "love"), "no second variable");
  assert.ok(!linked.installedBundles!.at(-1)!.variableIds.includes("love"));
  // A target that is not in the card: the pack's own is added as usual.
  const missing = editor.mergeBundleIntoWorld(world(), pack({ variables: [{ id: "love", name: "Love", type: "number", defaultValue: 0 } as never] }), undefined, {
    variableConflicts: { love: { mode: "merge", targetId: "nope" } },
  });
  assert.ok(missing.variables.some((v) => v.id === "love"));
});

test("settings are copied onto the record, pointed at the installed variables, and write back as one undo step", () => {
  const w = world();
  w.variables = [...w.variables, { id: "phone", name: "something else", type: "string", defaultValue: "" } as never];
  store.setState({ worldDraft: w });
  const installId = store.getState().importBundle(pack(), "hub-1")!;
  const record = store.getState().worldDraft.installedBundles!.find((r) => r.installId === installId)!;
  const field = record.settings![0]!;
  // "phone" was taken by id on the card, so the pack's maps onto it (same id).
  assert.equal(field.variableId, "phone");
  const pastBefore = store.getState()._past.length;
  store.getState().setBundleSettingValues([{ variableId: field.variableId, path: field.path, value: "nova" }]);
  assert.equal(store.getState()._past.length, pastBefore + 1);
  const v = store.getState().worldDraft.variables.find((x) => x.id === field.variableId)!;
  assert.deepEqual(v.defaultValue, { voice: { id: "nova" } });
});

test("detach keeps the content as the author's own", () => {
  store.setState({ worldDraft: world() });
  const installId = store.getState().importBundle(pack())!;
  const before = store.getState().worldDraft.entries.length;
  store.getState().detachInstalledBundle(installId);
  const after = store.getState().worldDraft;
  assert.equal(after.entries.length, before);
  assert.equal(after.entries.filter((e) => e.bundleInstallId).length, 0);
  assert.equal((after.installedBundles ?? []).length, 0);
});
