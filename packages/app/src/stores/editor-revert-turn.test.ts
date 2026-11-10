import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach } from "node:test";
import { createServer } from "vite";
import type { WorldDefinition, WorldEntry } from "@yumina/engine";

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, String(value)),
  removeItem: key => void memory.delete(key), clear: () => memory.clear(), key: () => null, length: 0,
};
const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { useEditorStore, draftFromStoredSchema } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const base = structuredClone(useEditorStore.getState().worldDraft);
after(() => vite.close());
afterEach(() => { useEditorStore.getState().stopAutosave(); memory.clear(); });

const entry = (id: string, content: string, position: number): WorldEntry =>
  ({ ...structuredClone(base.entries[0] ?? {}), id, name: id, content, section: "lore", position, folderId: undefined } as unknown as WorldEntry);
const card = (entries: WorldEntry[], temperature: number): WorldDefinition =>
  ({ ...structuredClone(base), entries, settings: { ...base.settings, temperature } });

test("undoing a turn keeps the author's later edits and is one undo step", () => {
  const before = card([entry("a", "old a", 0), entry("b", "b", 1)], 1);
  // The turn: rewrites a, adds c before b, changes the temperature.
  const end = card([entry("a", "assistant a", 0), entry("c", "assistant c", 1), entry("b", "b", 2)], 0.5);
  // The author then rewrites c.
  const now = card([entry("a", "assistant a", 0), entry("c", "author c", 1), entry("b", "b", 2)], 0.5);
  useEditorStore.setState({ worldDraft: now, guestMode: false, readOnlyInspect: false, isDirty: false, _past: [], _future: [], serverWorldId: null });

  const result = useEditorStore.getState().revertAssistantTurn(before, end);
  assert.deepEqual(result, { reverted: true, kept: 1 });
  const draft = useEditorStore.getState().worldDraft;
  assert.deepEqual(draft.entries.map(e => [e.id, e.content, e.position]), [["a", "old a", 0], ["c", "author c", 1], ["b", "b", 2]]);
  assert.equal(draft.settings.temperature, 1);
  assert.equal(useEditorStore.getState()._past.length, 1);

  useEditorStore.getState().undo();
  assert.deepEqual(useEditorStore.getState().worldDraft.entries, now.entries);
  assert.equal(useEditorStore.getState().worldDraft.settings.temperature, 0.5);
});

test("a turn the author has already undone by hand leaves no step behind", () => {
  const before = card([entry("a", "a", 0)], 1);
  const end = card([entry("a", "assistant", 0)], 1);
  useEditorStore.setState({ worldDraft: before, guestMode: false, readOnlyInspect: false, isDirty: false, _past: [], _future: [], serverWorldId: null });
  assert.deepEqual(useEditorStore.getState().revertAssistantTurn(before, end), { reverted: false, kept: 0 });
  assert.equal(useEditorStore.getState()._past.length, 0);
});

test("a stored snapshot is read with the same defaults a load fills in", () => {
  const stored = { name: "Card", entries: [], variables: [], settings: {} } as unknown as Record<string, unknown>;
  const draft = draftFromStoredSchema(stored, "w1");
  assert.equal(draft.id, "w1");
  assert.equal(draft.settings.playerName, "User");
  assert.deepEqual(draft.reactions, []);
});
