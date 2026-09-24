import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { useStore } from "zustand";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { planFolderImport } from "../../lib/asset-folder-import";
import * as tasks from "../../lib/asset-import-task";

test("dialog shows byte progress, closes without aborting, reopens and cancels separately", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  let aborted = false;
  const storage = { used: 0, limit: 1 };
  const store = tasks.createAssetImportStore({ storage: () => storage, createFolder: async () => ({ id: "folder" }),
    upload: async (_file, _type, _folder, signal, progress, stage) => {
      stage("storage"); progress({ fraction: 0.5, loaded: 5, total: 10, bytesPerSecond: 1 });
      return new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true }));
    } });
  store.getState().select({ parentFolderId: null, parentLabel: "Root", plan: planFolderImport([{ path: "folder/a.txt", file: new File(["1234567890"], "a.txt") }]) }, "A");
  const wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  const mocks: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/stores/user-assets": { useUserAssetStore: (selector: (value: { storage: typeof storage }) => unknown) => selector({ storage }) },
    "@/stores/asset-import": { assetImportStore: store, useAssetImportStore: (selector: (s: tasks.AssetImportStore) => unknown) => useStore(store, selector) },
    "@/lib/asset-import-task": tasks,
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "A" } }, isPending: false }) },
    "@/components/ui/dialog": { Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? wrapper({ children }) : null, DialogContent: wrapper, DialogHeader: wrapper, DialogDescription: wrapper, DialogTitle: wrapper },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { FolderUploadDialog: ComponentType } };
  new Function("require", "module", "exports", transform(readFileSync(new URL("./folder-upload-dialog.tsx", import.meta.url), "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  let root = createRoot(dom.window.document.getElementById("root")!);
  const render = () => root.render(createElement(module.exports.FolderUploadDialog));
  const button = (label: string) => [...dom.window.document.querySelectorAll("button")].find(b => b.textContent === label)!;
  try {
    await act(async () => render());
    assert.equal(button("assets.startFolderImport").disabled, true);
    storage.limit = 100;
    await act(async () => render());
    await act(async () => button("assets.startFolderImport").click());
    assert.equal(dom.window.document.querySelector('[aria-label="assets.currentFile"]')?.getAttribute("aria-valuenow"), "50");
    await act(async () => button("assets.backgroundUpload").click());
    assert.equal(aborted, false);
    assert.ok(dom.window.document.querySelector('[aria-label="assets.uploadTask"]'));
    await act(async () => root.unmount());
    assert.equal(aborted, false, "view unmount does not own the upload");
    root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => render());
    await act(async () => button("assets.uploadDetails").click());
    await act(async () => button("assets.cancelUpload").click());
    assert.equal(aborted, true);
    assert.equal(store.getState().task!.status, "cancelled");
  } finally {
    store.getState().resetOwner(null);
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
