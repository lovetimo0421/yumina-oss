import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";
import { jsonDefaultText, jsonDefaultUpdate } from "../features/editor/lib/json-default";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key),
} });
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  appType: "custom", logLevel: "silent", server: { middlewareMode: true },
});
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
after(async () => { useEditorStore.getState().stopAutosave(); await vite.close(); });

test("undo/redo restores incomplete JSON, formatting and runtime values together", async () => {
  const initial = '{ "z": 2, "a": 1 }';
  useEditorStore.setState({
    worldDraft: { ...useEditorStore.getState().worldDraft, variables: [
      { id: "v", name: "V", type: "json", defaultValue: { z: 2, a: 1 }, defaultValueText: initial },
    ] },
    _past: [], _future: [], canUndo: false, canRedo: false,
    isDirty: true, serverWorldId: null, readOnlyInspect: false, guestMode: false,
  });
  const current = () => useEditorStore.getState().worldDraft.variables[0]!;
  const store = useEditorStore.getState();
  store.updateVariableAt(0, jsonDefaultUpdate('{"z":'));
  assert.equal(jsonDefaultText(current()), '{"z":');
  assert.equal(await store.saveDraft(), false);
  store.undo();
  assert.equal(jsonDefaultText(current()), initial);
  store.redo();
  assert.equal(jsonDefaultText(current()), '{"z":');
  store.updateVariableAt(0, jsonDefaultUpdate('{"z":3,"a":1}'));
  assert.deepEqual(current().defaultValue, { z: 3, a: 1 });
  store.undo();
  assert.equal(jsonDefaultText(current()), '{"z":');
  assert.deepEqual(current().defaultValue, { z: 2, a: 1 });
  store.redo();
  assert.deepEqual(current().defaultValue, { z: 3, a: 1 });
});
