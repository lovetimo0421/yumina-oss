import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssetImportJob } from "@yumina/shared";
import { createAssetImportStore } from "./asset-imports";
import { AssetImportClientError, type AssetImportClient } from "@/lib/asset-import-client";

function job(id: string, filename = "assets.zip"): AssetImportJob {
  return { id, filename, folderId: "folder", status: "uploading", inputBytes: 5, expandedBytes: 10,
    fileCount: 2, ignoredCount: 0, succeeded: 0, skipped: 0, failed: 0, preserveFolders: true,
    conflict: "rename", errorCode: null, failures: [], folders: [], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), updatedAt: new Date().toISOString() };
}
function fakeClient() {
  const jobs = new Map<string, AssetImportJob>();
  let uploads = 0;
  let failUploaded = false;
  const change = (id: string, patch: Partial<AssetImportJob>) => { const next = { ...jobs.get(id)!, ...patch }; jobs.set(id, next); return next; };
  const client: AssetImportClient = {
    list: async () => [...jobs.values()],
    detail: async id => jobs.get(id)!,
    reserve: async input => { const value = job(input.id, input.filename); jobs.set(input.id, value); return { job: value, uploadUrl: input.id }; },
    uploaded: async id => { if (failUploaded) { failUploaded = false; throw new AssetImportClientError("ARCHIVE_NETWORK_ERROR"); } return change(id, { status: "queued_inspect" }); },
    start: async (id, options) => change(id, { ...options, status: "queued" }),
    retry: async id => change(id, { status: "queued", failed: 0, failures: [] }),
    dismiss: async id => { jobs.delete(id); },
    upload: async (_file, _url, progress) => { uploads++; progress(1); },
  };
  return { client, jobs, change, uploads: () => uploads, failUploaded: () => { failUploaded = true; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test("archive upload, approved options, background progress and retry survive a hidden sheet", async () => {
  const f = fakeClient();
  const store = createAssetImportStore(f.client);
  await store.getState().setOwner("alice");
  store.getState().enqueue([new File(["hello"], "assets.zip")], "folder");
  await settle();
  const id = store.getState().items[0]!.id;
  assert.equal(f.uploads(), 1);
  assert.equal(store.getState().items[0]!.file, undefined, "uploaded file bytes are released");
  f.change(id, { status: "ready" });
  await store.getState().refresh();
  await store.getState().start(false, "skip");
  assert.equal(f.jobs.get(id)!.preserveFolders, false);
  assert.equal(f.jobs.get(id)!.conflict, "skip");
  store.getState().hide();
  f.change(id, { status: "partial", succeeded: 1, failed: 1 });
  await store.getState().refresh();
  assert.equal(store.getState().open, false, "progress never steals focus");
  assert.equal(store.getState().items[0]!.job!.succeeded, 1);
  assert(store.getState().revision > 0);
  await store.getState().retry();
  assert.equal(f.uploads(), 1, "failed extracted entries do not reupload the archive");
  f.change(id, { status: "completed", succeeded: 2 });
  await store.getState().refresh();
  await store.getState().dismiss();
  assert.equal(store.getState().items.length, 0);
});

test("lost upload acknowledgement retries without transmitting the archive again", async () => {
  const f = fakeClient();
  const store = createAssetImportStore(f.client);
  await store.getState().setOwner("alice");
  f.failUploaded();
  store.getState().enqueue([new File(["hello"], "assets.zip")], "folder");
  await settle();
  assert.equal(store.getState().items[0]!.error, "ARCHIVE_NETWORK_ERROR");
  await store.getState().upload();
  assert.equal(f.uploads(), 1);
  assert.equal(store.getState().items[0]!.job!.status, "queued_inspect");
});

test("multiple archives queue behind the current preview, preserving their destination", async () => {
  const f = fakeClient();
  const store = createAssetImportStore(f.client);
  await store.getState().setOwner("alice");
  store.getState().enqueue([new File(["hello"], "one.zip"), new File(["hello"], "two.tar")], "folder");
  await settle();
  assert.equal(f.uploads(), 1);
  await store.getState().dismiss();
  await settle();
  assert.equal(f.uploads(), 2);
  assert.equal(store.getState().items[0]!.filename, "two.tar");
  assert.equal(store.getState().items[0]!.folderId, "folder");
});

test("server jobs recover after reload and late responses cannot cross accounts", async () => {
  const f = fakeClient();
  f.jobs.set("saved", { ...job("saved"), status: "partial", failed: 1 });
  const restored = createAssetImportStore(f.client);
  await restored.getState().setOwner("alice");
  assert.equal(restored.getState().items[0]!.id, "saved");
  assert.equal(restored.getState().open, false);
  let release!: (jobs: AssetImportJob[]) => void;
  const delayed = createAssetImportStore({ ...f.client, list: () => new Promise(resolve => { release = resolve; }) });
  const loading = delayed.getState().setOwner("alice");
  await delayed.getState().setOwner(null);
  release([job("private")]);
  await loading;
  assert.equal(delayed.getState().items.length, 0);
  assert.equal(delayed.getState().ownerId, null);
});
