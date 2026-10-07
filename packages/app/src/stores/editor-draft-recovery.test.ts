import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import type { WorldDefinition, WorldEntry } from "@yumina/engine";

/**
 * Restoring a crash-recovery draft must not clobber what the server gained
 * since the draft was made.
 *
 * The draft used to carry no base. Restoring it replaced the loaded draft and
 * kept the freshly loaded concurrency token, so the next save looked current,
 * never met STALE_WORLD, and wrote the old draft over the assistant's (or
 * another device's) newer work.
 */

const memory = new Map<string, string>();
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
const { useEditorStore: store, resolveRecoveredDraft } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const { feedback } = await vite.ssrLoadModule("/src/lib/feedback.tsx") as typeof import("../lib/feedback");
const { EDITOR_DRAFT_KEY } = await vite.ssrLoadModule("/src/features/editor/editor-draft-recovery.ts") as typeof import("../features/editor/editor-draft-recovery");

const empty = structuredClone(store.getState().worldDraft);
const entry = (id: string, content: string, position: number): WorldEntry => ({
  ...structuredClone(empty.entries[0] ?? ({} as WorldEntry)),
  id, name: id, content, role: "lore", section: "system-presets", position,
} as WorldEntry);
const world = (entries: WorldEntry[]): WorldDefinition => ({ ...structuredClone(empty), id: "w1", name: "Recovery", entries });

const T1 = "2026-09-20T10:00:00.000Z";
const T2 = "2026-09-21T10:00:00.000Z";

// Base: one entry. The draft (made from T1) edited it. The server, since,
// gained a new entry from the assistant and moved to T2.
const base = world([entry("a", "original", 0)]);
const draft = world([entry("a", "edited offline", 0)]);
const server = world([entry("a", "original", 0), entry("b", "written by the assistant", 1)]);

let persistentClick: (() => void) | null = null;
const originalPersistent = feedback.persistent;
const originalNotice = feedback.notice;
beforeEach(() => {
  memory.clear();
  persistentClick = null;
  (feedback as { persistent: unknown }).persistent = (_text: string, action: { onClick: () => void }) => {
    persistentClick = action.onClick;
    return () => {};
  };
  (feedback as { notice: unknown }).notice = () => {};
});
after(async () => {
  (feedback as { persistent: unknown }).persistent = originalPersistent;
  (feedback as { notice: unknown }).notice = originalNotice;
  store.getState().stopAutosave();
  await vite.close();
});

function serveWorld(schema: WorldDefinition, updatedAt: string) {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("/api/worlds/w1")) {
      return new Response(JSON.stringify({ data: { id: "w1", name: schema.name, schema, updatedAt, thumbnailUrl: null } }), { status: 200 });
    }
    throw new Error(`Unexpected network request: ${url}`);
  }) as typeof fetch;
}

const contents = (d: WorldDefinition) => Object.fromEntries(d.entries.map((e) => [e.id, e.content]));

test("restoring over a server that moved on merges instead of overwriting", async () => {
  memory.set(EDITOR_DRAFT_KEY, JSON.stringify({ draft, serverId: "w1", savedAt: Date.now(), baseUpdatedAt: T1, baseSchema: base }));
  serveWorld(server, T2);
  await store.getState().loadWorld("w1");
  assert.ok(persistentClick, "the recovery offer is shown");
  persistentClick!();
  const state = store.getState();
  assert.deepEqual(contents(state.worldDraft), { a: "edited offline", b: "written by the assistant" },
    "the offline edit is restored AND the assistant's entry survives");
  assert.equal(state.isDirty, true);
  assert.equal(state.baseUpdatedAt, T2, "the merged draft saves against the version it merged with");
});

test("a draft whose base is still the server's is restored as-is", async () => {
  memory.set(EDITOR_DRAFT_KEY, JSON.stringify({ draft, serverId: "w1", savedAt: Date.now(), baseUpdatedAt: T1, baseSchema: base }));
  serveWorld(base, T1);
  await store.getState().loadWorld("w1");
  persistentClick!();
  assert.deepEqual(contents(store.getState().worldDraft), { a: "edited offline" });
});

test("without a base schema the draft wins, and the server copy is kept aside", async () => {
  // Older drafts (and ones too big to store with their base) carry no base.
  memory.set(EDITOR_DRAFT_KEY, JSON.stringify({ draft, serverId: "w1", savedAt: Date.now() }));
  serveWorld(server, T2);
  await store.getState().loadWorld("w1");
  persistentClick!();
  assert.deepEqual(contents(store.getState().worldDraft), { a: "edited offline" });
  const stash = JSON.parse(memory.get("yumina-editor-conflict-w1") ?? "null");
  assert.ok(stash, "the server version is recoverable, not silently replaced");
  assert.equal(stash.serverDraft.entries.length, 2);
});

test("resolveRecoveredDraft: both sides editing the same entry keeps the draft and says so", () => {
  const serverEdited = world([entry("a", "edited by the assistant", 0)]);
  const result = resolveRecoveredDraft(
    { draft, baseUpdatedAt: T1, baseSchema: base },
    { baseUpdatedAt: T2, schema: serverEdited },
  );
  assert.equal(result.draft.entries.find((e) => e.id === "a")?.content, "edited offline");
  assert.equal(result.conflicts, 1);
  assert.equal(result.serverKeptAside, true);
});

test("the recovery offer waits for the editor's strings instead of showing the English fallback", async () => {
  const { default: i18n } = await vite.ssrLoadModule("/src/lib/i18n.ts") as { default: typeof import("i18next").default };
  const lng = i18n.language || "en";
  let shown = "";
  (feedback as { persistent: unknown }).persistent = (text: string, action: { onClick: () => void }) => {
    shown = text;
    persistentClick = action.onClick;
    return () => {};
  };
  const originalHas = i18n.hasLoadedNamespace.bind(i18n);
  const originalLoad = i18n.loadNamespaces.bind(i18n);
  i18n.hasLoadedNamespace = (() => false) as typeof i18n.hasLoadedNamespace;
  i18n.loadNamespaces = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    i18n.addResourceBundle(lng, "editor", { shell: { recoverDraftFound: "上次没保存的修改", recoverDraftAction: "恢复" } }, true, true);
  }) as typeof i18n.loadNamespaces;
  try {
    memory.set(EDITOR_DRAFT_KEY, JSON.stringify({ draft, serverId: "w1", savedAt: Date.now(), baseUpdatedAt: T1, baseSchema: base }));
    serveWorld(base, T1);
    await store.getState().loadWorld("w1");
    assert.equal(shown, "上次没保存的修改");
  } finally {
    i18n.hasLoadedNamespace = originalHas;
    i18n.loadNamespaces = originalLoad;
  }
});

test("leaving without saving drops the recovery copy and the in-memory edits; a crash keeps its copy", async () => {
  const { backupEditorDraft } = await vite.ssrLoadModule("/src/features/editor/editor-draft-recovery.ts") as typeof import("../features/editor/editor-draft-recovery");
  serveWorld(base, T1);
  await store.getState().loadWorld("w1");
  store.getState().updateEntry("a", { content: "typed, then thrown away" });
  assert.equal(store.getState().isDirty, true);

  // A crash / reload: the lifecycle backup keeps a copy to recover.
  assert.equal(backupEditorDraft(store.getState(), localStorage), true);
  assert.ok(memory.get(EDITOR_DRAFT_KEY), "a crash leaves a recovery copy");

  // 「不保存离开」: the dialog says the changes will be lost, so they are.
  store.getState().discardUnsavedChanges();
  assert.equal(memory.get(EDITOR_DRAFT_KEY), undefined, "no recovery copy after an explicit discard");
  assert.equal(store.getState().isDirty, false);
  // The route's own unmount backup finds nothing left to keep.
  assert.equal(backupEditorDraft(store.getState(), localStorage), false);
  assert.equal(memory.get(EDITOR_DRAFT_KEY), undefined);
  // A queued debounced write cannot bring it back either.
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.equal(memory.get(EDITOR_DRAFT_KEY), undefined);

  // As the editor route unmounts, the discarded copy leaves memory too, so an
  // in-app return loads the saved card instead of showing the edits as saved.
  store.getState().releaseDiscardedWorld("other-world");
  assert.equal(store.getState().serverWorldId, "w1", "another world's release is not this one");
  store.getState().releaseDiscardedWorld("w1");
  assert.equal(store.getState().serverWorldId, null);

  // Next open: nothing to recover.
  persistentClick = null;
  serveWorld(base, T1);
  await store.getState().loadWorld("w1");
  assert.equal(persistentClick, null, "no 「发现上次未保存的改动」 offer");
  assert.equal(contents(store.getState().worldDraft).a, "original");
});
