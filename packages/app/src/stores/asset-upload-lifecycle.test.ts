import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { createAssetImportStore } from "../lib/asset-import-task";
import { planFolderImport } from "../lib/asset-folder-import";

function load<T>(path: URL, mocks: Record<string, unknown>): T {
  const require = createRequire(path), module = { exports: {} };
  const source = readFileSync(path, "utf8").replaceAll("import.meta.env", "({})");
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  return module.exports as T;
}

test("reconciled folders update existing cards instead of appending duplicates", async () => {
  const previous = globalThis.fetch;
  const folder = { id: "existing-folder", userId: "alice", name: "clips", parentFolderId: null, assetCount: 3, createdAt: "" };
  const { useUserAssetStore } = load<typeof import("./user-assets")>(new URL("./user-assets.ts", import.meta.url), {
    "@/lib/feedback": {}, "@/lib/i18n": { default: {}, __esModule: true },
    "@/lib/asset-upload": { createUploadTimeout: () => ({ signal: new AbortController().signal, cleanup() {} }) },
  });
  useUserAssetStore.setState({ folders: [folder] });
  globalThis.fetch = async () => Response.json({ data: { id: folder.id, name: folder.name } });
  try {
    await useUserAssetStore.getState().createFolder("clips", undefined, { silent: true, requestId: crypto.randomUUID() });
    assert.equal(useUserAssetStore.getState().folders.length, 1);
    assert.equal(useUserAssetStore.getState().folders[0]!.assetCount, 3);
  } finally { globalThis.fetch = previous; }
});

test("reconciled uploads do not count storage twice and clear rejects late upload results", async () => {
  let complete!: (value: object) => void, delayed = false;
  const { useUserAssetStore } = load<typeof import("./user-assets")>(new URL("./user-assets.ts", import.meta.url), {
    "@/lib/feedback": { feedback: { error() {} } }, "@/lib/i18n": { default: { t: () => "" }, __esModule: true },
    "@/lib/asset-upload": { getAssetUploadErrorMessage: () => "", uploadAssetWithPresignedUrl: async (config: { onReconciled: () => void }) => {
      if (delayed) return new Promise(resolve => { complete = resolve; });
      config.onReconciled(); return { id: "existing" };
    } },
  });
  useUserAssetStore.setState({ storage: { used: 60, limit: 100 } });
  await useUserAssetStore.getState().uploadAsset(new File([new Uint8Array(60)], "a.txt"), "txt", undefined, { silent: true });
  assert.equal(useUserAssetStore.getState().storage.used, 60);
  delayed = true;
  const run = useUserAssetStore.getState().uploadAsset(new File(["a"], "b.txt"), "txt", undefined, { silent: true });
  useUserAssetStore.getState().clear();
  complete({ id: "old-owner" });
  assert.equal(await run, null);
  assert.deepEqual(useUserAssetStore.getState().assets, []);
  assert.equal(useUserAssetStore.getState().storage.used, 0);
});

test("auth cleanup aborts background upload synchronously without a mounted host", async () => {
  let aborted = false, assetClears = 0;
  const task = createAssetImportStore({ storage: () => ({ used: 0, limit: 100 }), createFolder: async () => ({ id: "folder" }),
    upload: async (_file, _type, _folder, signal) => new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true })) });
  task.getState().select({ parentFolderId: null, parentLabel: "Root", plan: planFolderImport([{ path: "folder/a.txt", file: new File(["a"], "a.txt") }]) }, "alice");
  const run = task.getState().start();
  await new Promise(resolve => setImmediate(resolve));
  const noop = () => {};
  const { clearAllStores } = load<typeof import("../lib/auth-client")>(new URL("../lib/auth-client.ts", import.meta.url), {
    "better-auth/react": { createAuthClient: () => ({}) }, "better-auth/client/plugins": { usernameClient: noop },
    "@/stores/asset-import": { assetImportStore: task },
    "@/stores/user-assets": { useUserAssetStore: { getState: () => ({ clear: () => { assetClears++; } }) } },
    "@/stores/user-profile": { useUserProfileStore: { getState: () => ({ clear: noop }) } },
    "@/edition/slots.state": { resetHostedStoresOnSignOut: noop },
    "@/stores/library": { useLibraryStore: { setState: noop } },
    "@/stores/ui": {}, "@/stores/studio-sidebar": {}, "@/lib/analytics": {},
    "@/lib/session-picker-cache": { clearSessionPickerCache: noop },
  });
  clearAllStores();
  assert.equal(aborted, true);
  assert.equal(assetClears, 1);
  assert.equal(task.getState().task, null);
  await run;
});
