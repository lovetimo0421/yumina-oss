import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import type { AssetPicker as Picker } from "./asset-picker";

for (const linkSucceeds of [true, false]) {
  for (const filterType of ["image", "media"] as const) {
  test(`${filterType} picker filters before pagination, then ${linkSucceeds ? "links before selecting" : "does not select after a failed link"}`, async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const originalFetch = globalThis.fetch;
    const events: string[] = [];
    const library: { id: string; type: string }[] = [];
    const upload = async () => { events.push("personal upload"); const asset = { id: "uploaded", type: "image" }; library.push(asset); return asset; };
    const worldState = { assets: [], fetchAssets: async () => {}, uploadAsset: async () => { events.push("world upload"); return { id: "world-only" }; } };
    const requests: unknown[] = [];
    const personalState = { assets: [], fetchAssets: async (options: unknown) => { requests.push(options); }, uploadAsset: upload };
    const source = readFileSync(new URL("./asset-picker.tsx", import.meta.url), "utf8").replaceAll("import.meta.env.VITE_API_URL", '""');
    const module = { exports: {} as { AssetPicker: typeof Picker } };
    const require = createRequire(import.meta.url);
    new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
      (id: string) => {
        if (id === "@/stores/assets") return { useAssetStore: () => worldState };
        if (id === "@/stores/user-assets") return { useUserAssetStore: () => personalState };
        if (id === "@/lib/utils") return { cn: (...values: string[]) => values.join(" ") };
        if (id === "@/lib/asset-upload") return { getUploadMetadata: () => ({ type: "image" }) };
        if (id === "@/lib/asset-url") return {};
        if (id === "@/lib/feedback") return { feedback: { error: () => events.push("error") } };
        if (id === "@/components/media-guidelines-note") return { MediaGuidelinesNote: () => null };
        if (id === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key }) };
        return require(id);
      }, module, module.exports,
    );
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/worlds/world/asset-refs");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(init!.body as string), { assetId: "uploaded" });
      events.push("link");
      return Response.json({}, { status: linkSucceeds ? 201 : 500 });
    };
    const root = createRoot(dom.window.document.getElementById("root")!);
    try {
      await act(async () => root.render(createElement(module.exports.AssetPicker, { worldId: "world", filterType, onClose: () => {}, onSelect: ref => events.push(ref) })));
      assert.deepEqual(requests, [{ page: 1, type: filterType }]);
      const input = dom.window.document.querySelector('input[type="file"]')!;
      Object.defineProperty(input, "files", { value: [new dom.window.File(["image"], "cover.png", { type: "image/png" })] });
      await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      assert.deepEqual(library, [{ id: "uploaded", type: "image" }]);
      assert.deepEqual(events, linkSucceeds ? ["personal upload", "link", "@asset:uploaded"] : ["personal upload", "link", "error"]);
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
}
