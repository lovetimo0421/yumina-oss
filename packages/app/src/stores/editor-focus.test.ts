import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach } from "node:test";
import { createServer } from "vite";

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, String(value)),
  removeItem: (key) => void memory.delete(key),
  clear: () => memory.clear(),
  key: () => null,
  length: 0,
};
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
after(() => vite.close());
afterEach(() => {
  useEditorStore.getState().stopAutosave();
  useEditorStore.setState({ pendingFocus: null, readOnlyInspect: false });
  memory.clear();
});

test("opening a named greeting or audio track does not edit the card or add undo history", () => {
  useEditorStore.setState({ isDirty: false, moduleScope: "mod:chapter-b", readOnlyInspect: true });
  const before = useEditorStore.getState();
  before.focusObject("greeting", "opening-three", "chapter-b");
  const opening = useEditorStore.getState();
  assert.equal(opening.activeSection, "first-message");
  assert.deepEqual(opening.pendingFocus, { kind: "greeting", id: "opening-three" });
  assert.equal(opening.moduleScope, "mod:chapter-b");
  opening.clearPendingFocus();
  assert.equal(useEditorStore.getState().pendingFocus, null);

  opening.focusObject("audio", "track-two");
  const audio = useEditorStore.getState();
  assert.equal(audio.activeSection, "audio");
  assert.deepEqual(audio.pendingFocus, { kind: "audio", id: "track-two" });
  assert.equal(audio.moduleScope, "mod:chapter-b");
  assert.equal(audio.worldDraft, before.worldDraft);
  assert.equal(audio._past, before._past);
  assert.equal(audio._future, before._future);
  assert.equal(audio.isDirty, false);
});

test("existing object handoffs retain their editor and ownership scope", () => {
  const store = useEditorStore.getState();
  store.focusObject("entry", "entry-b", "chapter-b");
  assert.equal(useEditorStore.getState().activeSection, "entries");
  assert.equal(useEditorStore.getState().moduleScope, "mod:chapter-b");
  store.focusObject("variable", "shared-hp");
  assert.equal(useEditorStore.getState().activeSection, "variables");
  assert.equal(useEditorStore.getState().moduleScope, "core");
  store.focusObject("reaction", "cold-damage", "chapter-c");
  assert.equal(useEditorStore.getState().activeSection, "rules");
  assert.equal(useEditorStore.getState().moduleScope, "mod:chapter-c");
  store.focusObject("module", "chapter-c");
  assert.equal(useEditorStore.getState().activeSection, "modules");
  assert.deepEqual(useEditorStore.getState().pendingFocus, { kind: "module", id: "chapter-c" });
});
