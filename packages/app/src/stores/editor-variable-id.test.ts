import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach } from "node:test";
import { createServer } from "vite";
import type { WorldDefinition } from "@yumina/engine";

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, String(value)),
  removeItem: (key) => void memory.delete(key), clear: () => memory.clear(), key: () => null, length: 0,
};
const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const base = structuredClone(useEditorStore.getState().worldDraft);
after(() => vite.close());
afterEach(() => { useEditorStore.getState().stopAutosave(); memory.clear(); });

function reset(overrides: Partial<WorldDefinition> = {}) {
  const worldDraft = { ...structuredClone(base), variables: [{ id: "hp", name: "Health", type: "number" as const, defaultValue: 10 }], entries: [], reactions: [], rules: [], worldbooks: [], components: [], customUI: [], rootComponent: undefined, uiDoc: undefined, uiBlueprint: undefined, ...overrides };
  useEditorStore.setState({ worldDraft, readOnlyInspect: false, isDirty: false, _past: [], _future: [], serverWorldId: null });
  return useEditorStore.getState();
}

test("the real store refuses referenced ID changes without dirtying the card or adding undo steps", () => {
  const before = reset({ entries: [{ id: "lore", name: "Lore", content: "HP: {{hp}}", role: "lore", section: "system-presets", position: 0, enabled: true, alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all" }] });
  before.updateVariableAt(0, { id: "renamed" });
  const after = useEditorStore.getState();
  assert.equal(after.worldDraft, before.worldDraft);
  assert.equal(after.worldDraft.variables[0]!.id, "hp");
  assert.equal(after.isDirty, false);
  assert.equal(after._past.length, 0);
});

test("the real store saves other fields while keeping an ID and its references intact", () => {
  const before = reset({ variables: [{ id: "hp", name: "Health", type: "number", defaultValue: 10, activation: { mode: "conditions", conditions: [{ variableId: "hp", operator: "gt", value: 0 }], conditionLogic: "all" } }] });
  before.updateVariableAt(0, { id: "new_hp", name: "Life", defaultValue: 20 });
  const after = useEditorStore.getState();
  assert.equal(after.worldDraft.variables[0]!.id, "hp");
  assert.equal(after.worldDraft.variables[0]!.name, "Life");
  assert.equal(after.worldDraft.variables[0]!.defaultValue, 20);
  assert.deepEqual(after.worldDraft.variables[0]!.activation, before.worldDraft.variables[0]!.activation);
  assert.equal(after._past.length, 1);
  after.undo();
  assert.deepEqual(useEditorStore.getState().worldDraft, before.worldDraft);
});

test("unreferenced IDs can change, including when frontend code uses the unchanged display name", () => {
  const before = reset({ rootComponent: { id: "ui", name: "UI", entryFile: "index.tsx", updatedAt: "", files: { "index.tsx": 'api.variables.Health; const label = "hp";' } } });
  before.updateVariableAt(0, { id: "  life  " });
  const after = useEditorStore.getState();
  assert.equal(after.worldDraft.variables[0]!.id, "life");
  assert.equal(after.worldDraft.variables[0]!.name, "Health");
  assert.equal(after.worldDraft.rootComponent, before.worldDraft.rootComponent);
  assert.equal(after._past.length, 1);
});

test("unreferenced ID collisions keep deduplication, and an empty ID cannot erase a variable", () => {
  const before = reset({ variables: [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }, { id: "life", name: "Other", type: "number", defaultValue: 0 }] });
  before.updateVariableAt(0, { id: "life" });
  assert.equal(useEditorStore.getState().worldDraft.variables[0]!.id, "life_2");
  assert.equal(useEditorStore.getState().worldDraft.variables[1]!.id, "life");
  useEditorStore.getState().updateVariableAt(0, { id: "   " });
  assert.equal(useEditorStore.getState().worldDraft.variables[0]!.id, "life_2");
  assert.equal(useEditorStore.getState()._past.length, 1);
});
