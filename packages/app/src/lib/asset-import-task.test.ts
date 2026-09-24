import assert from "node:assert/strict";
import test from "node:test";
import { createAssetImportStore, importProgress } from "./asset-import-task";
import { planFolderImport } from "./asset-folder-import";
import { activeReloadHolds } from "./reload-safety";

const selection = () => ({ parentFolderId: null, parentLabel: "Root", plan: planFolderImport(["a.txt", "b.txt"].map(name => ({ path: `folder/${name}`, file: new File(["1234567890"], name) }))) });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("lost commit responses reuse request IDs and retry can reconcile near full quota", async () => {
  let used = 0, loseFolderResponse = true, loseFileResponse = true;
  const folders = new Map<string, { id: string }>();
  const files = new Map<string, object>();
  const store = createAssetImportStore({ storage: () => ({ used, limit: 25 }),
    createFolder: async (_name, _parent, _signal, requestId) => {
      if (!folders.has(requestId)) folders.set(requestId, { id: "folder" });
      if (loseFolderResponse) { loseFolderResponse = false; return null; }
      return folders.get(requestId)!;
    },
    upload: async (_file, _type, _folder, _signal, _progress, _stage, requestId) => {
      if (!files.has(requestId)) { files.set(requestId, {}); used += 10; }
      if (loseFileResponse) { loseFileResponse = false; return null; }
      return files.get(requestId)!;
    } });
  store.getState().select(selection(), "A");
  await store.getState().start();
  assert.equal(folders.size, 1);
  await store.getState().start();
  assert.equal(used, 20);
  assert.equal(store.getState().task!.completed, 1);
  await store.getState().start();
  assert.equal(folders.size, 1);
  assert.equal(files.size, 2);
  assert.equal(used, 20);
  assert.equal(store.getState().task!.status, "complete");
});

test("hiding and unsubscribing preserve byte progress and the entire batch reload hold", async () => {
  let finish!: (value: object) => void;
  let files = 0;
  const store = createAssetImportStore({ storage: () => ({ used: 0, limit: 100 }), createFolder: async () => ({ id: "folder" }),
    upload: async (_file, _type, _folder, _signal, progress, stage) => {
      files++;
      stage("storage"); progress({ fraction: 0.5, loaded: 5, total: 10, bytesPerSecond: 2 });
      if (files === 1) return new Promise<object>(resolve => { finish = resolve; });
      return {};
    } });
  store.getState().select(selection(), "A");
  const unsubscribe = store.subscribe(() => {});
  const run = store.getState().start();
  await tick();
  assert.equal(importProgress(store.getState().task!).percent, 25);
  assert.equal(store.getState().task!.completed, 0);
  assert.ok(activeReloadHolds().includes("asset-folder-import"));
  store.getState().hide(); unsubscribe();
  assert.equal(store.getState().detailOpen, false);
  finish({}); await run;
  assert.equal(files, 2);
  assert.equal(store.getState().task!.status, "complete");
  assert.equal(importProgress(store.getState().task!).percent, 100);
  assert.ok(!activeReloadHolds().includes("asset-folder-import"));
});

test("cancel aborts current request and retry skips successful files and existing folders", async () => {
  const attempts: string[] = [];
  let folders = 0, aborted = false;
  const store = createAssetImportStore({ storage: () => ({ used: 0, limit: 100 }), createFolder: async () => { folders++; return { id: "folder" }; },
    upload: async (file, _type, _folder, signal) => {
      attempts.push(file.name);
      if (attempts.length !== 2) return {};
      return new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true }));
    } });
  store.getState().select(selection(), "A");
  const run = store.getState().start(); await tick();
  store.getState().cancel(); await run;
  assert.equal(aborted, true);
  assert.equal(store.getState().task!.status, "cancelled");
  await store.getState().start();
  assert.deepEqual(attempts, ["a.txt", "b.txt", "b.txt"]);
  assert.equal(folders, 1);
  assert.equal(store.getState().task!.status, "complete");
});

test("owner switch discards late callbacks and cannot corrupt the next owner's task", async () => {
  let finish!: (value: object) => void;
  let count = 0;
  const store = createAssetImportStore({ storage: () => ({ used: 0, limit: 100 }), createFolder: async () => ({ id: "folder" }),
    upload: async (_file, _type, _folder, _signal, progress) => {
      count++;
      if (count === 1) { await new Promise<object>(resolve => { finish = resolve; }); progress({ fraction: 1, loaded: 10, total: 10, bytesPerSecond: 1 }); }
      return {};
    } });
  store.getState().select(selection(), "A");
  const run = store.getState().start(); await tick();
  store.getState().resetOwner("B");
  assert.equal(store.getState().task, null);
  store.getState().select(selection(), "B");
  finish({}); await run;
  assert.equal(count, 1);
  assert.equal(store.getState().task!.ownerId, "B");
  assert.equal(store.getState().task!.completed, 0);
  assert.equal(store.getState().task!.progress, null);
  await store.getState().start();
  assert.equal(store.getState().task!.status, "complete");
});

test("quota gate starts no requests and a failed batch can retry only failures", async () => {
  let limit = 1, calls = 0;
  const store = createAssetImportStore({ storage: () => ({ used: 0, limit }), createFolder: async () => { calls++; return { id: "folder" }; },
    upload: async () => { calls++; return calls === 2 ? null : {}; } });
  store.getState().select(selection(), "A");
  await store.getState().start();
  assert.equal(calls, 0);
  assert.equal(store.getState().task!.quotaExceeded, true);
  limit = 100;
  await store.getState().start();
  assert.deepEqual(store.getState().task!.failed, ["folder/a.txt"]);
  await store.getState().start();
  assert.equal(calls, 4);
  assert.equal(store.getState().task!.status, "complete");
});
