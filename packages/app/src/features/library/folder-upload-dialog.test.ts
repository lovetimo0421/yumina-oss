import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import * as folderImport from "../../lib/asset-folder-import";
import type { FolderUploadSelection } from "./folder-upload-dialog";

test("folder dialog blocks oversized imports and unmount stops pending work without refreshing another account", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  let creates = 0, uploads = 0, refreshes = 0;
  let finishUpload!: (result: object) => void;
  const upload = new Promise<object>((resolve) => { finishUpload = resolve; });
  const store = {
    storage: { used: 0, limit: 1 },
    createFolder: async () => { creates++; return { id: "folder-id" }; },
    uploadAsset: async () => { uploads++; return upload; },
  };
  const useStore = Object.assign((selector: (value: typeof store) => unknown) => selector(store), { getState: () => store });
  const wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  const mocks: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/stores/user-assets": { useUserAssetStore: useStore },
    "@/lib/asset-folder-import": folderImport,
    "@/components/ui/dialog": { Dialog: wrapper, DialogContent: wrapper, DialogHeader: wrapper, DialogDescription: wrapper, DialogTitle: wrapper },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { FolderUploadDialog: ComponentType<{ selection: FolderUploadSelection; onClose: () => void; onRefresh: () => void }> } };
  new Function("require", "module", "exports", transform(readFileSync(new URL("./folder-upload-dialog.tsx", import.meta.url), "utf8"), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  const selection: FolderUploadSelection = {
    parentFolderId: null, parentLabel: "Root",
    plan: folderImport.planFolderImport(["a.txt", "b.txt"].map((name) => ({ path: `folder/${name}`, file: new File(["large text"], name) }))),
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = () => root.render(createElement(module.exports.FolderUploadDialog, { selection, onClose() {}, onRefresh() { refreshes++; } }));
  const start = () => [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "assets.startFolderImport")!;
  let unmounted = false;
  try {
    await act(async () => render());
    assert.equal(start().disabled, true);
    await act(async () => start().click());
    assert.equal(creates, 0);
    assert.equal(uploads, 0);
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /folderStorageExceeded/);
    store.storage = { used: 0, limit: 1000000 };
    await act(async () => render());
    await act(async () => start().click());
    assert.equal(creates, 1);
    assert.equal(uploads, 1);
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => finishUpload({ id: "asset" }));
    assert.equal(uploads, 1, "the second file never starts after unmount");
    assert.equal(refreshes, 0, "the new account is not refreshed by the old import");
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
