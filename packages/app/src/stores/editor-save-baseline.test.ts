import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach, beforeEach } from "node:test";
import { createServer } from "vite";
import type { WorldDefinition } from "@yumina/engine";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key),
} });
const originalFetch = globalThis.fetch;
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  configFile: false, appType: "custom", logLevel: "silent",
  resolve: { alias: {
    "@": fileURLToPath(new URL("..", import.meta.url)),
    "@yumina/engine": fileURLToPath(new URL("../../../engine/src/index.ts", import.meta.url)),
  } },
  server: { middlewareMode: true },
});
const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const { feedback } = await vite.ssrLoadModule("/src/lib/feedback.tsx") as typeof import("../lib/feedback");
const { useWorldsStore } = await vite.ssrLoadModule("/src/stores/worlds.ts") as typeof import("./worlds");
const empty = structuredClone(store.getState().worldDraft);
const time = (n: number) => `2026-09-16T21:00:0${n}.000Z`;
const source = (value: string) => `export default function App() { return <div>${value}</div>; }`;
const world = (value: string): WorldDefinition => ({
  ...structuredClone(empty), name: "Save baseline regression",
  rootComponent: { ...empty.rootComponent!, entryFile: "App.tsx", files: { "App.tsx": source(value) } },
});
function reset(base = world("A"), local = world("B"), id: string | null = "world") {
  store.getState().stopAutosave();
  store.setState({
    worldDraft: local, _baseSchema: id ? structuredClone(base) : null,
    serverWorldId: id, baseUpdatedAt: id ? time(1) : null,
    isDirty: true, saving: false, loadingWorld: false, lastSavedAt: 0,
    guestMode: false, readOnlyInspect: false,
    languageGroupId: null, language: null, variantLabel: null,
    pendingEdit: null, _pendingServerRefresh: false,
    _past: [], _future: [], canUndo: false, canRedo: false,
  });
  memory.clear();
}
function serverData(schema: WorldDefinition, updatedAt = time(2)) {
  return { id: "world", name: schema.name, schema, updatedAt, thumbnailUrl: null };
}
function requestBody(init?: RequestInit): { schema: WorldDefinition; baseUpdatedAt: string | null } {
  return JSON.parse(String(init?.body));
}
function changeDescription(value = "Unsaved description") {
  const current = store.getState().worldDraft;
  store.setState({ worldDraft: { ...current, description: value }, isDirty: true });
}
const rootSource = (draft: WorldDefinition | null) => draft?.rootComponent?.files["App.tsx"];

function delayedResponse(status = 200) {
  let release!: (value: unknown) => void;
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  const body = new Promise((resolve) => { release = resolve; });
  const response = { ok: status >= 200 && status < 300, status,
    json: () => { bodyStarted(); return body; } } as Response;
  return { response, started, release };
}

beforeEach((t) => {
  // These are store/network tests; feedback rendering needs a browser runtime.
  assert.ok("mock" in t, "Save tests require an individual test context");
  t.mock.method(feedback, "error", () => () => {});
  t.mock.method(feedback, "notice", () => () => {});
  t.mock.method(feedback, "persistent", () => () => {});
  t.mock.method(useWorldsStore.getState(), "invalidate", () => {});
});
afterEach(() => { globalThis.fetch = originalFetch; store.getState().stopAutosave(); });
after(async () => { await vite.close(); });

test("a successful save advances the ancestor before later agent changes are merged", async () => {
  reset();
  globalThis.fetch = async (_url, init) => Response.json({ data: serverData(requestBody(init).schema) });
  assert.equal(await store.getState().saveDraft(), true);
  assert.equal(rootSource(store.getState()._baseSchema), source("B"));

  changeDescription();
  globalThis.fetch = async () => Response.json({ data: serverData(world("C"), time(3)) });
  await store.getState().refreshWorldSchema();
  assert.equal(rootSource(store.getState().worldDraft), source("C"));
  assert.equal(store.getState().worldDraft.description, "Unsaved description");
  assert.equal(store.getState().isDirty, true);
});

test("edits made while the success body is loading stay dirty and out of the saved ancestor", async () => {
  reset();
  let release!: (value: unknown) => void;
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  const body = new Promise((resolve) => { release = resolve; });
  let submitted!: WorldDefinition;
  globalThis.fetch = async (_url, init) => {
    submitted = requestBody(init).schema;
    return { ok: true, json: () => { bodyStarted(); return body; } } as Response;
  };
  const saving = store.getState().saveDraft();
  await started;
  changeDescription("Typed while saving");
  release({ data: serverData(submitted) });
  assert.equal(await saving, true);
  assert.equal(store.getState().isDirty, true);
  assert.equal(store.getState().worldDraft.description, "Typed while saving");
  assert.notEqual(store.getState()._baseSchema?.description, "Typed while saving");
  assert.equal(rootSource(store.getState()._baseSchema), source("B"));
  assert.equal(store.getState().baseUpdatedAt, time(2));
});

test("server normalization remains a server change without discarding concurrent edits", async () => {
  reset();
  let normalized!: WorldDefinition;
  globalThis.fetch = async (_url, init) => {
    normalized = { ...requestBody(init).schema, name: "Server normalized name" };
    changeDescription("Still typing");
    return Response.json({ data: serverData(normalized) });
  };
  assert.equal(await store.getState().saveDraft(), true);
  assert.equal(store.getState()._baseSchema?.name, "Save baseline regression");
  assert.equal(rootSource(store.getState()._baseSchema), source("B"));
  assert.equal(store.getState().worldDraft.description, "Still typing");
  assert.notEqual(store.getState()._baseSchema?.description, "Still typing");
  assert.equal(store.getState().isDirty, true);

  globalThis.fetch = async () => Response.json({ data: serverData({
    ...world("C"), name: normalized.name,
  }, time(3)) });
  await store.getState().refreshWorldSchema();
  assert.equal(store.getState().worldDraft.name, normalized.name);
  assert.equal(rootSource(store.getState().worldDraft), source("C"));
  assert.equal(store.getState().worldDraft.description, "Still typing");
});

test("published saves use the accepted working draft instead of the live schema in the response", async () => {
  reset();
  globalThis.fetch = async () => Response.json({ data: {
    ...serverData(world("A")),
    pendingEdit: { status: "draft", reasons: ["frontend"], submittedAt: null,
      rejectionReason: null, rejectionDetail: null, updatedAt: time(2) },
  } });
  assert.equal(await store.getState().saveDraft(), true);
  assert.equal(rootSource(store.getState()._baseSchema), source("B"));
  assert.equal(rootSource(store.getState().worldDraft), source("B"));
  assert.equal(store.getState().isDirty, false);
});

test("409 merging keeps its server ancestor and a successful retry advances it", async () => {
  reset(world("A"), { ...world("A"), description: "Local description" });
  let patches = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method !== "PATCH") return Response.json({ data: serverData(world("C"), time(3)) });
    patches++;
    if (patches === 1) return Response.json({ code: "STALE_WORLD" }, { status: 409 });
    assert.equal(requestBody(init).baseUpdatedAt, time(3));
    return Response.json({ data: serverData(requestBody(init).schema, time(4)) });
  };
  assert.equal(await store.getState().saveDraft(), false);
  assert.equal(rootSource(store.getState().worldDraft), source("C"));
  assert.equal(store.getState().worldDraft.description, "Local description");
  assert.notEqual(store.getState()._baseSchema?.description, "Local description");
  assert.equal(store.getState().isDirty, true);
  assert.equal(await store.getState().saveDraft(), true);
  assert.equal(store.getState()._baseSchema?.description, "Local description");
  assert.equal(store.getState().baseUpdatedAt, time(4));
  assert.equal(store.getState().isDirty, false);

  changeDescription("Another local edit");
  globalThis.fetch = async () => Response.json({ data: serverData(world("D"), time(5)) });
  await store.getState().refreshWorldSchema();
  assert.equal(rootSource(store.getState().worldDraft), source("D"));
  assert.equal(store.getState().worldDraft.description, "Another local edit");
});

test("first save initializes the ancestor while keeping edits made during creation", async () => {
  reset(world("A"), world("B"), null);
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.method, "POST");
    const submitted = requestBody(init).schema;
    changeDescription("Typed during create");
    return Response.json({ data: serverData(submitted) }, { status: 201 });
  };
  assert.equal(await store.getState().saveDraft(), true);
  assert.equal(store.getState().serverWorldId, "world");
  assert.equal(rootSource(store.getState()._baseSchema), source("B"));
  assert.notEqual(store.getState()._baseSchema?.description, "Typed during create");
  assert.equal(store.getState().worldDraft.description, "Typed during create");
  assert.equal(store.getState().isDirty, true);
});

test("an unsuccessful save never advances the ancestor or the concurrency token", async () => {
  reset();
  const ancestor = store.getState()._baseSchema;
  globalThis.fetch = async () => Response.json({ error: "Temporary failure" }, { status: 503 });
  assert.equal(await store.getState().saveDraft(), false);
  assert.equal(store.getState()._baseSchema, ancestor);
  assert.equal(store.getState().baseUpdatedAt, time(1));
  assert.equal(store.getState().isDirty, true);
});

test("a late PATCH cannot change another world's baseline or finish its active save", async () => {
  reset();
  const oldSave = delayedResponse();
  const newSave = delayedResponse();
  const other = { ...world("Other world"), id: "other", name: "Other world" };
  globalThis.fetch = async (url, init) => {
    if (init?.method !== "PATCH") return Response.json({ data: { ...serverData(other, time(3)), id: "other" } });
    return String(url).endsWith("/other") ? newSave.response : oldSave.response;
  };
  const savingOld = store.getState().saveDraft();
  await oldSave.started;
  await store.getState().loadWorld("other");
  const otherBase = store.getState()._baseSchema;
  changeDescription("Other local edit");
  const savingNew = store.getState().saveDraft();
  await newSave.started;
  memory.set("yumina-editor-draft", "new recovery copy");
  oldSave.release({ data: { ...serverData(world("B")), pendingEdit: { status: "draft" } } });
  assert.equal(await savingOld, false);
  assert.equal(store.getState().serverWorldId, "other");
  assert.equal(store.getState()._baseSchema, otherBase);
  assert.equal(store.getState().baseUpdatedAt, time(3));
  assert.equal(store.getState().pendingEdit, null);
  assert.equal(store.getState().lastSavedAt, 0);
  assert.equal(store.getState().saving, true);
  assert.equal(store.getState().isDirty, true);
  assert.equal(memory.get("yumina-editor-draft"), "new recovery copy");
  newSave.release({ data: { ...serverData(store.getState().worldDraft, time(4)), id: "other" } });
  assert.equal(await savingNew, true);
  assert.equal(store.getState().saving, false);
  changeDescription("Keep this local edit");
  globalThis.fetch = async () => Response.json({ data: {
    ...serverData({ ...other, rootComponent: world("Other agent update").rootComponent }, time(5)), id: "other",
  } });
  await store.getState().refreshWorldSchema();
  assert.equal(rootSource(store.getState().worldDraft), source("Other agent update"));
  assert.equal(store.getState().worldDraft.description, "Keep this local edit");
});

test("a late POST cannot attach its server id to a different unsaved new card", async () => {
  reset(world("A"), world("B"), null);
  const delayed = delayedResponse(201);
  globalThis.fetch = async () => delayed.response;
  const saving = store.getState().saveDraft();
  await delayed.started;
  store.getState().createNew();
  changeDescription("Different new card");
  const currentDraft = store.getState().worldDraft;
  delayed.release({ data: serverData(world("B")) });
  assert.equal(await saving, false);
  assert.equal(store.getState().serverWorldId, null);
  assert.equal(store.getState()._baseSchema, null);
  assert.equal(store.getState().baseUpdatedAt, null);
  assert.equal(store.getState().worldDraft, currentDraft);
  assert.equal(store.getState().isDirty, true);
  assert.equal(store.getState().saving, false);
  assert.equal(store.getState().lastSavedAt, 0);
});

test("returning to the same world starts a different editor session", async () => {
  reset();
  const delayed = delayedResponse();
  globalThis.fetch = async (url, init) => init?.method === "PATCH" ? delayed.response : Response.json({
    data: { ...serverData(world("Reloaded"), time(3)), id: String(url).includes("/other?") ? "other" : "world" },
  });
  const saving = store.getState().saveDraft();
  await delayed.started;
  await store.getState().loadWorld("other");
  await store.getState().loadWorld("world");
  const reloadedBase = store.getState()._baseSchema;
  // Even a newer response belongs to the abandoned visit, not this reload.
  delayed.release({ data: serverData(world("B"), time(4)) });
  assert.equal(await saving, false);
  assert.equal(store.getState()._baseSchema, reloadedBase);
  assert.equal(rootSource(store.getState().worldDraft), source("Reloaded"));
  assert.equal(store.getState().baseUpdatedAt, time(3));
  assert.equal(store.getState().isDirty, false);
});

for (const lateToken of [time(1), undefined, "not-a-date"]) {
  test(`a refresh started before a successful save (${lateToken ?? "missing token"}) cannot roll the saved files back`, async () => {
    reset();
    const delayed = delayedResponse();
    globalThis.fetch = async (_url, init) => init?.method === "PATCH"
      ? Response.json({ data: serverData(requestBody(init).schema) }) : delayed.response;
    const refreshing = store.getState().refreshWorldSchema();
    await delayed.started;
    assert.equal(await store.getState().saveDraft(), true);
    changeDescription("Typed after save");
    const savedBase = store.getState()._baseSchema;
    const lastSavedAt = store.getState().lastSavedAt;
    delayed.release({ data: { ...serverData(world("A")), updatedAt: lateToken } });
    await refreshing;
    assert.equal(rootSource(store.getState().worldDraft), source("B"));
    assert.equal(store.getState().worldDraft.description, "Typed after save");
    assert.equal(store.getState()._baseSchema, savedBase);
    assert.equal(store.getState().baseUpdatedAt, time(2));
    assert.equal(store.getState().lastSavedAt, lastSavedAt);
    assert.equal(store.getState().isDirty, true);
  });
}

for (const lateToken of [time(2), undefined, "not-a-date"]) {
  test(`a late save response (${lateToken ?? "missing token"}) cannot replace a newer refreshed ancestor`, async () => {
    reset(world("A"), { ...world("A"), description: "Local description" });
    const delayed = delayedResponse();
    globalThis.fetch = async (_url, init) => init?.method === "PATCH" ? delayed.response
      : Response.json({ data: serverData(world("C"), time(3)) });
    const saving = store.getState().saveDraft();
    await delayed.started;
    await store.getState().refreshWorldSchema();
    const refreshedBase = store.getState()._baseSchema;
    delayed.release({ data: { ...serverData(world("A")), updatedAt: lateToken } });
    assert.equal(await saving, false);
    assert.equal(store.getState()._baseSchema, refreshedBase);
    assert.equal(store.getState().baseUpdatedAt, time(3));
    assert.equal(store.getState().lastSavedAt, 0);
    assert.equal(store.getState().isDirty, true);
    assert.equal(store.getState().saving, false);
    globalThis.fetch = async () => Response.json({ data: serverData(world("D"), time(4)) });
    await store.getState().refreshWorldSchema();
    assert.equal(rootSource(store.getState().worldDraft), source("D"));
    assert.equal(store.getState().worldDraft.description, "Local description");
  });
}

test("joining a first save waits for it without creating a duplicate world", async () => {
  reset(world("A"), world("B"), null);
  const delayed = delayedResponse(201);
  let requests = 0;
  globalThis.fetch = async () => { requests++; return delayed.response; };
  const saving = store.getState().saveDraft();
  await delayed.started;
  let joinedFinished = false;
  const joining = store.getState().saveDraft().then((saved) => { joinedFinished = true; return saved; });
  await Promise.resolve();
  assert.equal(joinedFinished, false);
  assert.equal(requests, 1);
  assert.equal(store.getState().saving, true);
  delayed.release({ data: serverData(world("B")) });
  assert.equal(await saving, true);
  assert.equal(await joining, true);
  assert.equal(requests, 1);
  assert.equal(store.getState().saving, false);
  assert.equal(store.getState().isDirty, false);
});

test("a joining save flushes edits made during creation with PATCH after POST finishes", async () => {
  reset(world("A"), world("B"), null);
  const creating = delayedResponse(201);
  const updating = delayedResponse();
  const requests: { method: string; schema: WorldDefinition }[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push({ method: init?.method ?? "", schema: requestBody(init).schema });
    return init?.method === "POST" ? creating.response : updating.response;
  };
  const first = store.getState().saveDraft();
  await creating.started;
  changeDescription("Required before starting the agent");
  let joinedFinished = false;
  const joining = store.getState().saveDraft().then((saved) => { joinedFinished = true; return saved; });
  await Promise.resolve();
  assert.equal(joinedFinished, false);
  assert.equal(requests.length, 1);
  creating.release({ data: serverData(world("B")) });
  assert.equal(await first, true);
  await updating.started;
  assert.equal(joinedFinished, false);
  assert.deepEqual(requests.map((r) => r.method), ["POST", "PATCH"]);
  assert.equal(requests[1]?.schema.description, "Required before starting the agent");
  updating.release({ data: serverData(requests[1]!.schema, time(3)) });
  assert.equal(await joining, true);
  assert.equal(store.getState().isDirty, false);
  assert.equal(store.getState().baseUpdatedAt, time(3));
});

for (const response of [
  { status: 409, body: { code: "STALE_WORLD" } },
  { status: 409, body: { code: "WORLD_IN_REVIEW" } },
  { status: 503, body: { error: "Old world failure" } },
]) {
  test(`a late ${response.status} ${"code" in response.body ? response.body.code : "failure"} cannot affect the new editor session`, async (t) => {
    reset();
    const error = t.mock.method(feedback, "error", () => () => {});
    const delayed = delayedResponse(response.status);
    let requests = 0;
    globalThis.fetch = async () => { requests++; return delayed.response; };
    const saving = store.getState().saveDraft();
    await delayed.started;
    store.getState().createNew();
    const newDraft = store.getState().worldDraft;
    delayed.release(response.body);
    assert.equal(await saving, false);
    assert.equal(store.getState().worldDraft, newDraft);
    assert.equal(store.getState()._baseSchema, null);
    assert.equal(store.getState().worldStatus, null);
    assert.equal(store.getState().saving, false);
    assert.equal(error.mock.callCount(), 0);
    assert.equal(requests, 1);
  });
}

test("a conflict fetch from an old session cannot merge into the next card", async (t) => {
  reset();
  const error = t.mock.method(feedback, "error", () => () => {});
  const delayed = delayedResponse();
  globalThis.fetch = async (_url, init) => init?.method === "PATCH"
    ? Response.json({ code: "STALE_WORLD" }, { status: 409 }) : delayed.response;
  const saving = store.getState().saveDraft();
  await delayed.started;
  store.getState().createNew();
  changeDescription("New card contents");
  const newDraft = store.getState().worldDraft;
  delayed.release({ data: serverData(world("Old agent update"), time(3)) });
  assert.equal(await saving, false);
  assert.equal(store.getState().worldDraft, newDraft);
  assert.equal(store.getState()._baseSchema, null);
  assert.equal(store.getState().baseUpdatedAt, null);
  assert.equal(error.mock.callCount(), 0);
  assert.equal(memory.has("yumina-editor-conflict-world"), false);
});

test("an old network failure stays silent after navigation", async (t) => {
  reset();
  const error = t.mock.method(feedback, "error", () => () => {});
  let reject!: (error: Error) => void;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  const response = new Promise<Response>((_resolve, rejectPromise) => { reject = rejectPromise; });
  globalThis.fetch = async () => { requested(); return response; };
  const saving = store.getState().saveDraft();
  await started;
  store.getState().createNew();
  reject(new Error("Old request disconnected"));
  assert.equal(await saving, false);
  assert.equal(store.getState().saving, false);
  assert.equal(store.getState().serverWorldId, null);
  assert.equal(error.mock.callCount(), 0);
});
