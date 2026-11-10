import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach, beforeEach } from "node:test";
import { createServer } from "vite";
import type { GraphLayout, UiDoc, WorldDefinition, YuminaBundle } from "@yumina/engine";

const memory = new Map<string, string>();
const originalFetch = globalThis.fetch;
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
const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const { compileUiDoc } = await vite.ssrLoadModule("/@fs/" + fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url))) as typeof import("@yumina/engine");
const { bundleTSX } = await vite.ssrLoadModule("/src/lib/tsx/tsx-bundler.ts") as typeof import("@/lib/tsx/tsx-bundler");
const initial = structuredClone(store.getState().worldDraft);
const layout: GraphLayout = { version: 5, nodes: { "module:test": { x: 55, y: 44, pinned: true } }, notes: [{ id: "note-a", x: 0, y: 0, w: 240, h: 150, text: "Author planning text" }] };
const originalCode = 'export default function Original(){return <button onClick={()=>{}}>ORIGINAL_FRONTEND</button>}';

beforeEach(() => {
  globalThis.fetch = async url => { throw new Error(`Unexpected network request: ${url}`); };
  store.setState({ worldDraft: structuredClone(initial), serverWorldId: "card", isDirty: false, layoutDirty: false, saving: false, guestMode: false, readOnlyInspect: false, _baseSchema: structuredClone(initial), _past: [], _future: [], _pendingServerRefresh: false });
});
afterEach(() => {
  store.getState().stopAutosave();
  // A request a test abandoned must not be joined by the next one: starting a
  // fresh editor session is what tells the save serializer the old save is over.
  store.getState().createNew();
  memory.clear();
});
after(async () => {
  await vite.close();
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function serverResponse() {
  return Response.json({ data: { id: "card", name: "Agent title", schema: { ...initial, name: "Agent title" }, updatedAt: "2026-09-06T10:00:00Z" } });
}
function importUiBundle(name: string) {
  const bundle: YuminaBundle = {
    bundleVersion: "3.0.0", name, description: "", tags: [], createdAt: "2026-09-06T09:00:00Z",
    entries: [], variables: [], rules: [], audioTracks: [],
    rootComponent: { id: name, name, entryFile: "index.tsx", files: { "index.tsx": `export default function Bundle(){return <div>${name}</div>}` }, updatedAt: "2026-09-06T09:00:00Z" },
  };
  store.getState().importBundle(bundle);
  return store.getState().worldDraft.installedBundles!.at(-1)!;
}
function handwrittenCard() {
  store.setState({ worldDraft: { ...structuredClone(initial), rootComponent: { id: "root", name: "Root", entryFile: "index.tsx", files: { "index.tsx": originalCode }, updatedAt: "2026-09-06T09:00:00Z" } } });
}
async function savedSchema() {
  let payload: WorldDefinition | undefined;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/worlds/card");
    assert.equal(options?.method, "PATCH");
    payload = JSON.parse(String(options?.body)).schema;
    return Response.json({ data: { updatedAt: "2026-09-06T11:00:00Z" } });
  };
  assert.equal(await store.getState().saveDraft(), true);
  assert.ok(payload);
  return payload;
}
function assertRuns(world: WorldDefinition, markers: string[]) {
  const result = bundleTSX(world.rootComponent!);
  assert.equal(result.error, null);
  for (const marker of markers) assert.ok(result.code?.includes(marker), `compiled UI contains ${marker}`);
}

test("AI refresh retains layout-only notes, applies server content, and keeps the layout save pending", async () => {
  store.getState().setGraphLayout(layout);
  globalThis.fetch = async () => serverResponse();
  await store.getState().refreshWorldSchema();
  assert.deepEqual(store.getState().worldDraft.graphLayout, layout);
  assert.equal(store.getState().worldDraft.name, "Agent title");
  assert.equal(store.getState().isDirty, false);
  assert.equal(store.getState().layoutDirty, true);
  assert.deepEqual((await savedSchema()).graphLayout, layout);
  assert.equal(store.getState().layoutDirty, false);
});

test("refresh and stale-save merge retain notes alongside local content", async () => {
  store.getState().setGraphLayout(layout);
  store.getState().setField("description", "Local prose");
  globalThis.fetch = async () => serverResponse();
  await store.getState().refreshWorldSchema();
  assert.deepEqual(store.getState().worldDraft.graphLayout, layout);
  assert.equal(store.getState().worldDraft.description, "Local prose");
  globalThis.fetch = async (_url, options) => options?.method === "PATCH"
    ? Response.json({ code: "STALE_WORLD" }, { status: 409 }) : serverResponse();
  assert.equal(await store.getState().saveDraft(), false);
  assert.deepEqual(store.getState().worldDraft.graphLayout, layout);
  assert.equal(store.getState().worldDraft.description, "Local prose");
});

test("a later stale save merges against the last successful save, retaining another tab's newer edit", async () => {
  store.getState().setField("name", "First saved title");
  const saved = await savedSchema();
  store.getState().setField("description", "Local change after saving");
  const remote = { ...saved, name: "New title from another tab" };
  globalThis.fetch = async (_url, options) => options?.method === "PATCH"
    ? Response.json({ code: "STALE_WORLD" }, { status: 409 })
    : Response.json({ data: { id: "card", name: remote.name, description: remote.description, schema: remote, updatedAt: "2026-09-06T12:00:00Z" } });
  assert.equal(await store.getState().saveDraft(), false);
  assert.equal(store.getState().worldDraft.name, remote.name, "the previously saved title is no longer a local edit");
  assert.equal(store.getState().worldDraft.description, "Local change after saving");
  assert.equal(store.getState().isDirty, true);
  assert.equal(memory.has("yumina-editor-conflict-card"), false, "independent edits must not produce a conflict backup");
});

test("a stale save after different concurrent renames preserves the server title for conflict recovery", async () => {
  store.getState().setField("name", "This page's title");
  const serverDraft = { ...structuredClone(initial), name: "Other page's title" };
  globalThis.fetch = async (_url, options) => options?.method === "PATCH"
    ? Response.json({ code: "STALE_WORLD" }, { status: 409 })
    : Response.json({ data: { id: "card", name: serverDraft.name, schema: serverDraft, updatedAt: "remote-token" } });
  assert.equal(await store.getState().saveDraft(), false);
  assert.equal(store.getState().worldDraft.name, "This page's title");
  assert.equal(store.getState().isDirty, true);
  const backup = memory.get("yumina-editor-conflict-card");
  assert.ok(backup, "a discarded server title must remain recoverable just like a conflicting opening");
  const recovered = JSON.parse(backup);
  assert.equal(recovered.serverDraft.name, "Other page's title");
  assert.deepEqual(recovered.conflicts, [{ collection: "field", id: "name", reason: "both-edited" }]);
});

test("overlapping saves do not send duplicate requests or mark newer edits saved", async () => {
  store.setState({ worldDraft: { ...store.getState().worldDraft, rootComponent: undefined } });
  let release!: (response: Response) => void;
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    if (!init?.method) return Response.json({ data: [] });
    requests++;
    if (requests > 1) return Response.json({ data: { updatedAt: "2026-09-06T13:00:01Z" } });
    return new Promise<Response>(resolve => { release = resolve; });
  };
  store.getState().setField("name", "Sent title");
  const first = store.getState().saveDraft();
  const second = store.getState().saveDraft();
  // The second caller joins the request in flight instead of duplicating it
  // (main line, 0.0.33.0), then flushes whatever was typed while it ran.
  assert.equal(requests, 1);
  store.getState().setField("name", "Still typing");
  release(Response.json({ data: { updatedAt: "2026-09-06T13:00:00Z" } }));
  assert.equal(await first, true);
  assert.equal(store.getState().worldDraft.name, "Still typing");
  assert.equal(await second, true);
  assert.equal(requests, 2);
  assert.equal(store.getState()._baseSchema?.name, "Still typing");
  assert.equal(store.getState().isDirty, false);
});

test("a save that finishes after changing cards cannot overwrite the new card's merge base or status", async () => {
  store.setState({ worldDraft: { ...store.getState().worldDraft, rootComponent: undefined } });
  let release!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve; });
  store.getState().setField("name", "Old card edit");
  const pending = store.getState().saveDraft();
  const next = { ...structuredClone(initial), id: "different", name: "Other card" };
  store.setState({ worldDraft: next, serverWorldId: "different", _baseSchema: structuredClone(next), baseUpdatedAt: "new-card-token", isDirty: true, saving: false });
  release(Response.json({ data: { updatedAt: "old-card-token" } }));
  assert.equal(await pending, false);
  assert.equal(store.getState()._baseSchema?.name, "Other card");
  assert.equal(store.getState().baseUpdatedAt, "new-card-token");
  assert.equal(store.getState().isDirty, true);
});

test("switching to a fresh card during a save releases the save lock when the old request finishes", async () => {
  store.setState({ worldDraft: { ...store.getState().worldDraft, rootComponent: undefined } });
  let release!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve; });
  const pending = store.getState().saveDraft();
  store.getState().createNew();
  release(Response.json({ data: { updatedAt: "old-token" } }));
  assert.equal(await pending, false);
  assert.equal(store.getState().saving, false);
  assert.equal(store.getState().serverWorldId, null);
});

for (const nextCard of ["new", "loaded"] as const) {
  test(`switching to a ${nextCard} card transfers the save lock before the previous request finishes`, async () => {
    store.setState({ worldDraft: { ...store.getState().worldDraft, rootComponent: undefined } });
    const requests: { url: string; release: (response: Response) => void }[] = [];
    globalThis.fetch = async (url, options) => {
      if (!options?.method) return String(url).includes("/api/worlds/next-card?")
        ? Response.json({ data: { id: "next-card", name: "Next card", schema: { ...initial, id: "next-card", rootComponent: undefined } } })
        : Response.json({ data: [] });
      return new Promise<Response>(release => requests.push({ url: String(url), release }));
    };
    const first = store.getState().saveDraft();
    if (nextCard === "new") store.getState().createNew();
    else await store.getState().loadWorld("next-card");
    store.getState().setField("rootComponent", undefined);
    store.getState().setField("name", "Next card edit");
    const lockAfterSwitch = store.getState().saving;
    const second = store.getState().saveDraft();
    const requestCount = requests.length;
    requests[0]!.release(Response.json({ data: { id: "card", updatedAt: "2026-09-06T13:00:00Z" } }));
    const firstResult = await first;
    const lockAfterOldResponse = store.getState().saving;
    requests[1]?.release(Response.json({ data: { id: "next-card", updatedAt: "2026-09-06T13:00:05Z" } }));
    const secondResult = await second;
    assert.equal(lockAfterSwitch, false, "the previous card cannot keep the new card locked");
    assert.equal(requestCount, 2, "the new card can save while the old request is pending");
    assert.equal(firstResult, false);
    assert.equal(lockAfterOldResponse, true, "the old finally must not release the new card's lock");
    assert.equal(secondResult, true);
    assert.equal(store.getState().saving, false);
    assert.equal(store.getState().baseUpdatedAt, "2026-09-06T13:00:05Z");
    assert.equal(store.getState().worldDraft.name, "Next card edit");
  });
}

for (const serverWorldId of ["card", null]) {
  test(`${serverWorldId ? "updating" : "creating"} a card keeps metadata edited during the request dirty until its next save`, async () => {
    store.setState({ serverWorldId, worldDraft: { ...store.getState().worldDraft, rootComponent: undefined }, language: "en", variantLabel: "Original", isDirty: true });
    let release!: (response: Response) => void;
    const payloads: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, options) => {
      if (!options?.method) return Response.json({ data: [] });
      payloads.push(JSON.parse(String(options?.body)));
      return new Promise<Response>(resolve => { release = resolve; });
    };
    const pending = store.getState().saveDraft();
    store.getState().setLanguage("ja");
    store.getState().setVariantLabel("Latest label");
    release(Response.json({ data: { id: "card", updatedAt: "first-token" } }));
    assert.equal(await pending, true);
    assert.equal(store.getState().isDirty, true, "metadata is editable while the content request is pending");
    const next = store.getState().saveDraft();
    release(Response.json({ data: { id: "card", updatedAt: "second-token" } }));
    assert.equal(await next, true);
    assert.equal(payloads[0]!.language, "en");
    assert.equal(payloads[0]!.variantLabel, "Original");
    assert.equal(payloads[1]!.language, "ja");
    assert.equal(payloads[1]!.variantLabel, "Latest label");
    assert.equal(store.getState().isDirty, false);
  });
}

test("an in-place import during a request retains that save lock and stays dirty", async () => {
  store.setState({ worldDraft: { ...store.getState().worldDraft, rootComponent: undefined } });
  let release!: (response: Response) => void;
  const requests: string[] = [];
  globalThis.fetch = async (url, options) => {
    if (!options?.method) return Response.json({ data: [] });
    requests.push(String(url));
    if (requests.length > 1) return Response.json({ data: { updatedAt: "2026-09-06T13:00:01Z" } });
    return new Promise<Response>(resolve => { release = resolve; });
  };
  const pending = store.getState().saveDraft();
  store.getState().loadWorldDefinition({ ...store.getState().worldDraft, name: "Imported update" }, { preserveServerState: true });
  const lockAfterImport = store.getState().saving;
  // A second caller joins the request in flight (main line, 0.0.33.0) and then
  // writes the imported draft, instead of being turned away while it saves.
  const overlapping = store.getState().saveDraft();
  release(Response.json({ data: { updatedAt: "2026-09-06T13:00:00Z" } }));
  assert.equal(await pending, true);
  assert.equal(lockAfterImport, true);
  assert.equal(await overlapping, true);
  assert.deepEqual(requests, ["/api/worlds/card", "/api/worlds/card"]);
  assert.equal(store.getState().worldDraft.name, "Imported update");
  assert.equal(store.getState().baseUpdatedAt, "2026-09-06T13:00:01Z");
  assert.equal(store.getState().isDirty, false);
});

test("a content save cannot acknowledge unrelated metadata changed during its request", async () => {
  store.setState({ worldDraft: { ...store.getState().worldDraft, rootComponent: undefined }, isDirty: true });
  let release!: (response: Response) => void;
  globalThis.fetch = async (_url, options) => options?.method
    ? new Promise<Response>(resolve => { release = resolve; }) : Response.json({ data: [] });
  const pending = store.getState().saveDraft();
  store.getState().setGalleryImages(["new-gallery-image"]);
  store.getState().setAnnouncement("New announcement");
  store.getState().setApproxTime("2 hours");
  store.getState().setTags(["new-tag"]);
  release(Response.json({ data: { updatedAt: "content-token" } }));
  assert.equal(await pending, true);
  assert.equal(store.getState().isDirty, true);
  assert.equal(store.getState().announcement, "New announcement");
});

test("loading a target card cannot save the previous draft, and cancelling that load unlocks a fresh card", async () => {
  store.setState({ worldDraft: { ...store.getState().worldDraft, rootComponent: undefined } });
  let finishLoad!: (response: Response) => void;
  let writes = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/api/worlds/target?")) return new Promise<Response>(resolve => { finishLoad = resolve; });
    if (!options?.method) return Response.json({ data: [] });
    writes++;
    return Response.json({ data: { id: "fresh-card", updatedAt: "fresh-token" } });
  };
  const loading = store.getState().loadWorld("target");
  const prematureSave = await store.getState().saveDraft();
  const prematureWrites = writes;
  store.getState().createNew();
  store.getState().setField("rootComponent", undefined);
  store.getState().setField("name", "Fresh card instead");
  const saved = await store.getState().saveDraft();
  finishLoad(Response.json({ data: { id: "target", schema: { ...initial, id: "target" } } }));
  await loading;
  assert.equal(prematureSave, false);
  assert.equal(prematureWrites, 0, "a half-loaded document cannot create a duplicate of the previous card");
  assert.equal(saved, true);
  assert.equal(store.getState().loadingWorld, false);
  assert.equal(store.getState().serverWorldId, "fresh-card");
  assert.equal(store.getState().worldDraft.name, "Fresh card instead");
});

test("uiDoc edits and saves retain imported bundles; uninstall removes only that bundle", async () => {
  handwrittenCard();
  store.getState().adoptUiDoc();
  const first = importUiBundle("FIRST_BUNDLE");
  const second = importUiBundle("SECOND_BUNDLE");
  const doc = structuredClone(store.getState().worldDraft.uiDoc!);
  doc.pages[0]!.height += 20;
  store.getState().setUiDoc(doc);
  // Wait on observable compiler output, with a generous deadline for CI.
  const expectedEntry = compileUiDoc(doc).files["index.tsx"];
  const deadline = Date.now() + 5000;
  while (store.getState().worldDraft.rootComponent!.files["__user-root.tsx"] !== expectedEntry && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(store.getState().worldDraft.rootComponent!.files["__user-root.tsx"], expectedEntry);
  assertRuns(store.getState().worldDraft, ["ORIGINAL_FRONTEND", "FIRST_BUNDLE", "SECOND_BUNDLE"]);
  const saved = await savedSchema();
  assertRuns(saved, ["ORIGINAL_FRONTEND", "FIRST_BUNDLE", "SECOND_BUNDLE"]);
  assert.equal(saved.rootComponent!.updatedAt, store.getState().worldDraft.rootComponent!.updatedAt, "unchanged saves preserve the interface version");
  store.getState().removeInstalledBundle(first.installId);
  assertRuns(store.getState().worldDraft, ["ORIGINAL_FRONTEND", "SECOND_BUNDLE"]);
  assert.ok(!bundleTSX(store.getState().worldDraft.rootComponent!).code?.includes("FIRST_BUNDLE"));
  store.getState().removeInstalledBundle(second.installId);
  assertRuns(await savedSchema(), ["ORIGINAL_FRONTEND"]);
});

test("decomposing an existing bundle composer keeps each bundle mounted once through later imports and removal", async () => {
  handwrittenCard();
  const first = importUiBundle("FIRST_BUNDLE");
  store.getState().adoptUiDoc();
  assert.ok(store.getState().worldDraft.uiDoc?.base);
  importUiBundle("SECOND_BUNDLE");
  const world = await savedSchema();
  assertRuns(world, ["ORIGINAL_FRONTEND", "FIRST_BUNDLE", "SECOND_BUNDLE"]);
  const baseFile = world.uiDoc!.base!.file;
  assert.ok(!world.rootComponent!.files["index.tsx"]!.includes("_bundles/"), "the preserved base owns bundle composition");
  assert.ok(world.rootComponent!.files[baseFile]!.includes("_bundles/second-bundle"));
  assert.equal(world.rootComponent!.files["__user-root.tsx"], originalCode);
  store.getState().removeInstalledBundle(first.installId);
  const after = await savedSchema();
  assertRuns(after, ["ORIGINAL_FRONTEND", "SECOND_BUNDLE"]);
  assert.ok(!bundleTSX(after.rootComponent!).code?.includes("FIRST_BUNDLE"));
});

test("a generated card without bundles keeps its direct uiDoc entry", async () => {
  store.getState().adoptUiDoc();
  const doc = store.getState().worldDraft.uiDoc as UiDoc;
  const saved = await savedSchema();
  assert.equal(saved.rootComponent!.files["index.tsx"], compileUiDoc(doc).files["index.tsx"]);
  assert.equal(saved.rootComponent!.files["__user-root.tsx"], undefined);
});

test("saving repairs a uiDoc card previously persisted with its bundle composer overwritten", async () => {
  handwrittenCard();
  store.getState().adoptUiDoc();
  importUiBundle("RECOVERED_BUNDLE");
  const world = store.getState().worldDraft;
  // This is the exact payload produced by the old save path: all sibling
  // files survive, but the generated entry replaces the bundle composer.
  store.setState({ worldDraft: { ...world, rootComponent: {
    ...world.rootComponent!, files: { ...world.rootComponent!.files, ...compileUiDoc(world.uiDoc!).files },
  } } });
  assert.ok(!bundleTSX(store.getState().worldDraft.rootComponent!).code?.includes("RECOVERED_BUNDLE"));
  assertRuns(await savedSchema(), ["ORIGINAL_FRONTEND", "RECOVERED_BUNDLE"]);
});


test("a save carries the complete editor metadata", async () => {
  store.setState({ galleryImages: ["cover.png"], tags: ["fantasy"], announcement: "Release note", approxTime: "10 min" });
  const payloads: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(String(options?.body)));
    return Response.json({ data: { updatedAt: "2026-09-06T11:00:00Z" } });
  };
  // Saving never mints a version — the merged server writes version rows on
  // publication, not on save — so there is no longer an opt-out flag to send.
  assert.equal(await store.getState().saveDraft(), true);
  assert.equal("saveVersion" in payloads[0]!, false);
  assert.deepEqual(payloads[0]!.galleryImages, ["cover.png"]);
  assert.deepEqual(payloads[0]!.tags, ["fantasy"]);
  assert.equal(payloads[0]!.announcement, "Release note");
  assert.equal(payloads[0]!.approxTime, "10 min");
});


test("saving after Publish keeps its settings while reconciliation preserves newer edits and other cards", { skip: "Hosted publishing implementation is not exported" }, async () => {
  const { reconcileEditorSettings } = await vite.ssrLoadModule("/src/features/hub/publish/reconcile-editor-settings.ts");
  const before = store.getState();
  const published = { id: "card", tags: ["published-tag"], announcement: "Published announcement", approxTime: "15 min", updatedAt: "2026-09-06T12:00:00Z" };
  store.setState(reconcileEditorSettings(store.getState(), before, published));
  assert.equal(store.getState().baseUpdatedAt, before.baseUpdatedAt, "a metadata response must not acknowledge unseen schema edits");
  store.setState({ isDirty: true, worldDraft: { ...store.getState().worldDraft, description: "New lore edit" } });
  let payload: Record<string, unknown> = {};
  globalThis.fetch = async (_url, options) => { payload = JSON.parse(String(options?.body)); return Response.json({ data: { updatedAt: published.updatedAt } }); };
  assert.equal(await store.getState().saveDraft(), true);
  assert.deepEqual(payload.tags, published.tags);
  assert.equal(payload.announcement, published.announcement);
  assert.equal(payload.approxTime, published.approxTime);
  const newer = { ...before, announcement: "Newer typing", baseUpdatedAt: "newer-token" };
  const merged = reconcileEditorSettings(newer, before, published);
  assert.equal(merged.announcement, undefined);
  assert.equal(merged.baseUpdatedAt, undefined);
  assert.deepEqual(reconcileEditorSettings({ ...before, serverWorldId: "another" }, before, published), {});
});
