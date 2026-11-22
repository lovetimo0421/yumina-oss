import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";
import type { YuminaBundle } from "@yumina/engine";

// Resource packs, step 3: an installed pack moves to the author's newer
// version under the same install, and what the installer made of it stays:
// their edits to its objects, and every value they set through its settings.

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
after(async () => {
  editor.useEditorStore.getState().stopAutosave();
  await vite.close();
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function v1(): YuminaBundle {
  return {
    bundleVersion: "3.0.0", name: "Companion", description: "", tags: [], createdAt: "2026-10-28T00:00:00.000Z", version: 1,
    entries: [
      { id: "persona", name: "Character sheet", content: "Name:", role: "character", keywords: [], enabled: true, position: 0 } as never,
      { id: "speech", name: "How she talks", content: "Short lines.", role: "style", keywords: [], enabled: true, position: 1 } as never,
      { id: "old", name: "Old tip", content: "Gone in v2", role: "system", keywords: [], enabled: true, position: 2 } as never,
    ],
    variables: [
      { id: "companion", name: "companion", type: "json", defaultValue: { name: "" } } as never,
      { id: "rapport", name: "Rapport", type: "number", defaultValue: 10 } as never,
    ],
    rules: [],
    reactions: [{ id: "r1", name: "wave", when: { kind: "turn" }, conditions: [], conditionLogic: "all", then: [] } as never],
    audioTracks: [],
    settings: [{ id: "name", label: "Name", type: "text", variableId: "companion", path: "name" }],
  };
}

function v2(): YuminaBundle {
  const b = v1();
  b.version = 2;
  b.entries = [
    { ...b.entries[0]!, content: "Name:\nAge:" },            // author changed the sheet
    { ...b.entries[1]!, content: "Short lines, warm." },     // author changed speech
    { id: "new", name: "New tip", content: "Added in v2", role: "system", keywords: [], enabled: true, position: 3 } as never,
  ];
  b.variables = [b.variables[0]!, { ...b.variables[1]!, defaultValue: 20 }];
  return b;
}

function installed() {
  const base = editor.createEmptyWorld();
  const world = editor.mergeBundleIntoWorld(base, v1(), "pack-1");
  const record = world.installedBundles!.at(-1)!;
  // The installer: fills the name in the settings form, rewrites the speech
  // entry, and edits the tip the author is about to drop.
  const variables = world.variables.map((v) => (record.variableIds.includes(v.id) && v.name === "companion" ? { ...v, defaultValue: { name: "Yuki" } } : v));
  const entries = world.entries.map((e) => {
    if (e.bundleInstallId !== record.installId) return e;
    if (e.name === "How she talks") return { ...e, content: "Teasing, playful." };
    if (e.name === "Old tip") return { ...e, content: "My own note" };
    return e;
  });
  return { world: { ...world, variables, entries }, installId: record.installId };
}

test("an update keeps the install, the installer's edits and their settings, and takes everything else from the new version", () => {
  const { world, installId } = installed();
  const { world: out, report } = editor.updateBundleInWorld(world, installId, v2(), v1());
  const record = out.installedBundles!.find((b) => b.installId === installId)!;
  assert.ok(record, "same install id");
  assert.equal(record.version, 2);
  const mine = out.entries.filter((e) => e.bundleInstallId === installId);
  const byName = (n: string) => out.entries.find((e) => e.name === n);
  assert.equal(byName("Character sheet")?.content, "Name:\nAge:", "untouched object follows the author");
  assert.equal(byName("How she talks")?.content, "Teasing, playful.", "installer's edit kept");
  assert.equal(byName("New tip")?.content, "Added in v2", "new object arrives");
  assert.equal(byName("Old tip")?.content, "My own note", "an edited object the author dropped stays");
  assert.equal(byName("Old tip")?.bundleInstallId, undefined, "…as the installer's own");
  assert.equal(mine.length, 3);
  const companion = out.variables.find((v) => v.name === "companion");
  assert.deepEqual(companion?.defaultValue, { name: "Yuki" }, "settings value kept");
  assert.equal(out.variables.find((v) => v.name === "Rapport")?.defaultValue, 20, "unedited variable follows the author");
  assert.equal(out.variables.filter((v) => v.name === "companion").length, 1, "no duplicate variables");
  const kinds = report.edits.map((e) => `${e.kind}:${e.name}:${e.alsoChangedUpstream}:${e.removedUpstream}`).sort();
  assert.deepEqual(kinds, ["entry:How she talks:true:false", "entry:Old tip:false:true", "variable:companion:false:false"]);
  assert.deepEqual(report.added, ["New tip"]);
  assert.ok(report.removed.includes("Old tip"));
});

test("taking the author's version of an edited object drops the installer's edit", () => {
  const { world, installId } = installed();
  const speech = v1().entries.find((e) => e.name === "How she talks")!.id;
  const { world: out } = editor.updateBundleInWorld(world, installId, v2(), v1(), { takeUpstream: new Set([speech]) });
  assert.equal(out.entries.find((e) => e.name === "How she talks")?.content, "Short lines, warm.");
});

test("a dry run reports without changing the world", () => {
  const { world, installId } = installed();
  const { world: same, report } = editor.updateBundleInWorld(world, installId, v2(), v1(), { dryRun: true });
  assert.equal(same, world);
  assert.equal(report.edits.length, 3);
});

test("without the old version, only settings values carry over", () => {
  const { world, installId } = installed();
  const { world: out } = editor.updateBundleInWorld(world, installId, v2(), null);
  assert.equal(out.entries.find((e) => e.name === "How she talks")?.content, "Short lines, warm.");
  assert.deepEqual(out.variables.find((v) => v.name === "companion")?.defaultValue, { name: "Yuki" });
});
