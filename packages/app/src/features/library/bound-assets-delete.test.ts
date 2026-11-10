import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import type { BoundAssetsView } from "./bound-assets-view";

for (const deleted of [true, false]) {
  test(`bound folder ${deleted ? "removes a deleted asset" : "keeps a protected asset visible after confirmation"}`, async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const originalFetch = globalThis.fetch;
    const noop = () => {};
    const empty = () => null;
    const wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
    const asset = { id: "asset", type: "txt", filename: "retained.txt", url: "/cdn/asset" };
    const folder = { id: "folder", name: "My folder", previewAssetIds: [], assetCount: 1 };
    let deletions = 0;
    const assets = { folders: [folder], fetchFolders: noop, deleteAsset: async () => { deletions++; return deleted; } };
    const bindings = { bindings: [folder], worldId: "world", loading: false, fetch: noop };
    const require = createRequire(import.meta.url);
    const mocks: Record<string, unknown> = {
      "@/lib/asset-upload-policy": {},
      "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "owner" } } }) },
      "@/edition/edition": { useFeature: () => false },
      "@/edition/slots": { GenerationPanel: empty },
      "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
      "@/lib/feedback": { feedback: { error: noop } },
      "@/hooks/use-copy-feedback": { useCopyFeedback: () => ({ copy: noop }) },
      "@/stores/folder-bindings": { useFolderBindingStore: (select: (state: typeof bindings) => unknown) => select(bindings) },
      "@/stores/user-assets": { useUserAssetStore: (select: (state: typeof assets) => unknown) => select(assets) },
      "@/stores/asset-imports": { useAssetImportStore: (select: (state: object) => unknown) => select({ items: [], revision: 0 }) },
      "@/lib/asset-url": {}, "@/lib/asset-upload": {}, "@yumina/shared": {},
      "@/components/media-guidelines-note": { MediaGuidelinesNote: empty },
      "@/components/ui/dialog": {
        Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement("div", { role: "dialog" }, children) : null,
        DialogContent: wrapper, DialogHeader: wrapper, DialogTitle: wrapper, DialogDescription: empty,
      },
    };
    const source = readFileSync(new URL("./bound-assets-view.tsx", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
    const module = { exports: {} as { BoundAssetsView: typeof BoundAssetsView } };
    new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
      (id: string) => mocks[id] ?? require(id), module, module.exports,
    );
    globalThis.fetch = async url => Response.json({ data: String(url).includes("folderId=") ? [asset] : [] });
    const root = createRoot(dom.window.document.getElementById("root")!);
    const click = (element: Element) => act(async () => { element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    try {
      await act(async () => root.render(createElement(module.exports.BoundAssetsView, { worldId: "world" })));
      await click([...dom.window.document.querySelectorAll("button")].find(b => b.textContent?.includes("My folder"))!);
      assert.ok(dom.window.document.body.textContent?.includes("retained.txt"));
      await click(dom.window.document.querySelector('button[title="assets.delete"]')!);
      await click([...dom.window.document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === "bulk.delete")!);
      assert.equal(deletions, 1);
      assert.equal(dom.window.document.body.textContent?.includes("retained.txt"), !deleted);
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  });
}
