import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach } from "node:test";
import { createServer } from "vite";
import type { Reaction, Variable } from "@yumina/engine";

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, String(value)),
  removeItem: key => void memory.delete(key), clear: () => memory.clear(), key: () => null, length: 0,
};
const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const base = structuredClone(useEditorStore.getState().worldDraft);
after(() => vite.close());
afterEach(() => { useEditorStore.getState().stopAutosave(); memory.clear(); });

const variable: Variable = {
  id: "inventory", name: "背包", type: "json", defaultValue: { items: ["key"] },
  min: 0, max: 100, description: "Owned items", behaviorRules: "Keep item IDs", updateHints: "legacy hint",
  scope: "setup", internal: false, aiAccess: "read", enabled: false, worldbookId: "mine",
  activation: { mode: "conditions", conditionLogic: "any", conditions: [{ variableId: "hp", operator: "gt", value: 0, valueRef: "threshold" }] },
};
const reaction: Reaction = {
  id: "cold", name: "寒冷", description: "Cold damage", when: { eventType: "turn:complete" },
  conditions: [{ variableId: "hp", operator: "gt", value: 0 }], conditionLogic: "any",
  stopConditions: [{ variableId: "warm", operator: "eq", value: true }],
  then: [{ type: "set", path: "hp", operation: "subtract", value: 1, valueRandom: { kind: "dice", count: 1, sides: 6, modifier: 0 } }],
  priority: 3, cooldownTurns: 4, maxFireCount: 7, chance: 30, enabled: false, maxChainDepth: 2, worldbookId: "mine",
};
function reset() {
  useEditorStore.setState({ worldDraft: { ...structuredClone(base), variables: [structuredClone(variable)], reactions: [structuredClone(reaction)] }, guestMode: false, readOnlyInspect: false, isDirty: false, _past: [], _future: [], serverWorldId: null });
  return useEditorStore.getState();
}

test("variable copies preserve all configuration and nested values, and undo as one edit", () => {
  const before = reset();
  const id = before.duplicateVariable(variable.id, "副本");
  const after = useEditorStore.getState();
  const copy = after.worldDraft.variables[1]!;
  assert.ok(id && id !== variable.id);
  assert.deepEqual(copy, { ...variable, id, name: "背包 (副本)" });
  assert.notEqual(copy.defaultValue, after.worldDraft.variables[0]!.defaultValue);
  assert.notEqual(copy.activation, after.worldDraft.variables[0]!.activation);
  assert.equal(after._past.length, 1);
  after.undo();
  assert.deepEqual(useEditorStore.getState().worldDraft, before.worldDraft);
});

test("behavior copies retain STOP, random effects, module, chance and cooldown settings", () => {
  const before = reset();
  const id = before.duplicateReaction(reaction.id, "副本");
  const after = useEditorStore.getState();
  const copy = after.worldDraft.reactions![1]!;
  assert.ok(id && id !== reaction.id);
  assert.deepEqual(copy, { ...reaction, id, name: "寒冷 (副本)" });
  assert.notEqual(copy.then, after.worldDraft.reactions![0]!.then);
  assert.notEqual(copy.stopConditions, after.worldDraft.reactions![0]!.stopConditions);
  assert.equal(after._past.length, 1);
  after.undo();
  assert.deepEqual(useEditorStore.getState().worldDraft, before.worldDraft);
});

test("the canvas's spaced copy word still makes a clean name, and copying a copy counts up", () => {
  const first = reset().duplicateVariable(variable.id, " 副本");
  const firstName = useEditorStore.getState().worldDraft.variables.find(item => item.id === first)!.name;
  assert.equal(firstName, "背包 (副本)");
  const second = useEditorStore.getState().duplicateVariable(first!, " 副本");
  assert.equal(useEditorStore.getState().worldDraft.variables.find(item => item.id === second)!.name, "背包 (副本 2)");
});

test("repeat copies get distinct names and read-only or missing objects cannot duplicate", () => {
  reset().duplicateVariable(variable.id, "副本");
  useEditorStore.getState().duplicateVariable(variable.id, "副本");
  assert.equal(new Set(useEditorStore.getState().worldDraft.variables.map(item => item.name)).size, 3);
  useEditorStore.setState({ readOnlyInspect: true });
  const before = useEditorStore.getState();
  assert.equal(before.duplicateVariable(variable.id), null);
  assert.equal(before.duplicateReaction(reaction.id), null);
  assert.equal(before.duplicateReaction("missing"), null);
  assert.equal(useEditorStore.getState().worldDraft, before.worldDraft);
});
