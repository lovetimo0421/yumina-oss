import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const memory = new Map<string, string>();
globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, String(v)), removeItem: k => void memory.delete(k), clear: () => memory.clear(), key: () => null, length: 0 };
const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
after(async () => { await vite.close(); });
afterEach(() => { useEditorStore.getState().stopAutosave(); memory.clear(); });

function fresh() {
  const s = useEditorStore.getState(); s.createNew(); s.stopAutosave();
  useEditorStore.setState({ worldDraft: { ...useEditorStore.getState().worldDraft, variables: [{ id: "old", name: "旧", type: "number", defaultValue: 0 }] } });
}

test("every way the editor makes a variable turns precise tracking on; saved ones are untouched", () => {
  fresh();
  const s = useEditorStore.getState();
  s.addVariable();
  const byName = s.ensureVariableByName("好感度", "number", 10);
  const internal = s.ensureVariableByName("历史", "json", [], true);
  const vars = useEditorStore.getState().worldDraft.variables;
  const find = (id: string) => vars.find(v => v.id === id)!;
  assert.equal(find("old").precise, undefined, "a saved variable keeps its setting");
  assert.deepEqual([vars.at(1)!.precise, vars.at(1)!.deltaDown, vars.at(1)!.deltaUp], [true, 10, 10]);
  assert.equal(find(byName).precise, true);
  assert.equal(find(internal).precise, undefined, "internal bookkeeping is never tracked");
  const text = s.ensureVariableByName("你的名字", "string", "");
  assert.equal(useEditorStore.getState().worldDraft.variables.find(v => v.id === text)!.precise, undefined, "a free-text answer has nothing to pick from");
});

test("a fresh variable's suggested window follows the range it is given; a typed window stays", () => {
  fresh();
  const s = useEditorStore.getState();
  s.addVariable();
  const index = useEditorStore.getState().worldDraft.variables.length - 1;
  s.updateVariableAt(index, { min: 0, max: 100 });
  let v = useEditorStore.getState().worldDraft.variables[index]!;
  assert.deepEqual([v.deltaDown, v.deltaUp], [15, 15]);
  s.updateVariableAt(index, { deltaUp: 3 });
  s.updateVariableAt(index, { max: 200 });
  v = useEditorStore.getState().worldDraft.variables[index]!;
  assert.deepEqual([v.deltaDown, v.deltaUp], [15, 3]);
});
