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

after(async () => {
  await vite.close();
});

afterEach(() => {
  const store = useEditorStore.getState();
  store.setGuestMode(false);
  store.setReadOnlyInspect(false);
  store.stopAutosave();
  store.createNew();
  memory.clear();
});

test("guest mode rejects draft, history, and metadata mutations", () => {
  const store = useEditorStore.getState();
  store.createNew();
  store.setField("name", "Visible preview");
  store.setTags(["existing"]);
  store.setLanguage("en");
  store.setAnnouncement("Existing announcement");
  store.setApproxTime("10 minutes");
  store.setVariantLabel("Primary");
  store.stopAutosave();
  useEditorStore.setState({ isDirty: false });
  store.setGuestMode(true);

  const before = useEditorStore.getState();
  const recoveryBefore = new Map(memory);
  store.beginBatch();
  store.setField("name", "Lost guest draft");
  store.setTags(["guest"]);
  store.setLanguage("zh");
  store.setGalleryImages(["guest.png"]);
  store.setAnnouncement("Guest announcement");
  store.setApproxTime("2 hours");
  store.setVariantLabel("Guest variant");
  store.undo();
  store.redo();
  store.commitBatch();

  const after = useEditorStore.getState();
  assert.equal(after.worldDraft, before.worldDraft);
  assert.deepEqual(after.tags, ["existing"]);
  assert.equal(after.language, "en");
  assert.deepEqual(after.galleryImages, []);
  assert.equal(after.announcement, "Existing announcement");
  assert.equal(after.approxTime, "10 minutes");
  assert.equal(after.variantLabel, "Primary");
  assert.equal(after._batchDepth, before._batchDepth);
  assert.equal(after.isDirty, before.isDirty);
  assert.deepEqual(after._past, before._past);
  assert.deepEqual(after._future, before._future);
  assert.deepEqual(memory, recoveryBefore);
});

test("authenticated and admin-inspect editor mutations keep their existing behavior", () => {
  const store = useEditorStore.getState();
  store.createNew();
  store.setField("name", "Authenticated edit");
  store.setTags(["saved"]);
  assert.equal(useEditorStore.getState().worldDraft.name, "Authenticated edit");
  assert.deepEqual(useEditorStore.getState().tags, ["saved"]);

  store.setReadOnlyInspect(true);
  store.setField("name", "Local admin inspection");
  assert.equal(useEditorStore.getState().worldDraft.name, "Local admin inspection");
});
