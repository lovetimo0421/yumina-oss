import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach, beforeEach } from "node:test";
import { createServer } from "vite";
import type { WorldDefinition, WorldEntry } from "@yumina/engine";

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

const entry = (id: string, worldbookId?: string, folderId?: string): WorldEntry => ({
  id,
  name: id,
  content: "",
  role: "custom",
  alwaysSend: false,
  keywords: [],
  conditions: [],
  conditionLogic: "all",
  enabled: true,
  position: 0,
  section: "system-presets",
  worldbookId,
  folderId,
});

function seedWorld(): void {
  const current = useEditorStore.getState().worldDraft;
  const worldDraft: WorldDefinition = {
    ...current,
    version: "21.0.0",
    entries: [entry("entry-a", "book-a"), entry("entry-b", "book-b")],
    entryFolders: [],
    worldbooks: [
      { id: "book-a", name: "A", activation: { mode: "always" }, order: 0 },
      { id: "book-b", name: "B", activation: { mode: "always" }, order: 1 },
    ],
  };
  useEditorStore.setState({ worldDraft, isDirty: false });
}

beforeEach(seedWorld);

afterEach(() => {
  useEditorStore.getState().stopAutosave();
  memory.clear();
});

after(async () => {
  await vite.close();
});

test("folders are created and ordered inside one knowledge base", () => {
  const store = useEditorStore.getState();
  store.addFolder("system-presets", "A folder", "book-a");
  store.addFolder("system-presets", "B folder", "book-b");

  const folders = useEditorStore.getState().worldDraft.entryFolders ?? [];
  assert.equal(folders.length, 2);
  assert.deepEqual(folders.map((folder) => folder.worldbookId), ["book-a", "book-b"]);
  assert.deepEqual(folders.map((folder) => folder.order), [0, 0]);
});

test("new folder entries inherit scope and section defaults in a single undo step", () => {
  const store = useEditorStore.getState();
  store.addFolder("post-history", "B folder", "book-b");
  const folder = useEditorStore.getState().worldDraft.entryFolders![0]!;
  const before = useEditorStore.getState().worldDraft;
  store.addEntry("custom", "system-presets", { folderId: folder.id, worldbookId: "book-a" });
  const created = useEditorStore.getState().worldDraft.entries.at(-1)!;
  assert.equal(created.folderId, folder.id);
  assert.equal(created.worldbookId, "book-b");
  assert.equal(created.section, "post-history");
  assert.equal(created.alwaysSend, true);
  store.undo();
  assert.deepEqual(useEditorStore.getState().worldDraft, before);
  store.redo();
  assert.deepEqual(useEditorStore.getState().worldDraft.entries.at(-1), created);
});

test("Main book folders override supplied book and deleted folders cannot receive new entries", () => {
  const store = useEditorStore.getState();
  store.addFolder("examples", "Main examples");
  const folder = useEditorStore.getState().worldDraft.entryFolders![0]!;
  store.addEntry("example", "examples", { folderId: folder.id, worldbookId: "book-b", content: "<START>" });
  const created = useEditorStore.getState().worldDraft.entries.at(-1)!;
  assert.equal(created.worldbookId, undefined);
  assert.equal(created.content, "<START>");
  const before = useEditorStore.getState().worldDraft;
  store.addEntry("custom", "system-presets", { folderId: "missing" });
  assert.equal(useEditorStore.getState().worldDraft, before);
});

test("putting an entry in a folder atomically adopts the folder book and section", () => {
  useEditorStore.getState().addFolder("post-history", "B folder", "book-b");
  const folder = useEditorStore.getState().worldDraft.entryFolders![0]!;

  useEditorStore.getState().updateEntry("entry-a", { folderId: folder.id });
  const updated = useEditorStore.getState().worldDraft.entries.find((item) => item.id === "entry-a")!;
  assert.equal(updated.folderId, folder.id);
  assert.equal(updated.worldbookId, "book-b");
  assert.equal(updated.section, "post-history");
});

test("moving an entry to another knowledge base clears its old folder", () => {
  useEditorStore.getState().addFolder("system-presets", "A folder", "book-a");
  const folder = useEditorStore.getState().worldDraft.entryFolders![0]!;
  useEditorStore.getState().updateEntry("entry-a", { folderId: folder.id });

  useEditorStore.getState().setEntryWorldbook("entry-a", "book-b");
  const updated = useEditorStore.getState().worldDraft.entries.find((item) => item.id === "entry-a")!;
  assert.equal(updated.worldbookId, "book-b");
  assert.equal(updated.folderId, undefined);
});

test("deleting a knowledge base moves both its entries and folders to Main", () => {
  useEditorStore.getState().addFolder("system-presets", "A folder", "book-a");
  const folder = useEditorStore.getState().worldDraft.entryFolders![0]!;
  useEditorStore.getState().updateEntry("entry-a", { folderId: folder.id });

  useEditorStore.getState().removeWorldbook("book-a");
  const state = useEditorStore.getState().worldDraft;
  assert.equal(state.entryFolders![0]!.worldbookId, undefined);
  const movedEntry = state.entries.find((item) => item.id === "entry-a")!;
  assert.equal(movedEntry.worldbookId, undefined);
  assert.equal(movedEntry.folderId, folder.id);
});
