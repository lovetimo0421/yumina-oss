import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { transform } from "sucrase";
import type { useUserAssetStore as Store, UserAsset } from "./user-assets";

function loadStore() {
  const errors: { message: string; action?: unknown }[] = [];
  const source = readFileSync(new URL("./user-assets.ts", import.meta.url), "utf8")
    .replaceAll("import.meta.env.VITE_API_URL", '""');
  const module = { exports: {} as { useUserAssetStore: typeof Store } };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)(
    (id: string) => {
      if (id === "@/lib/feedback") return { feedback: { error: (message: string, action?: unknown) => errors.push({ message, action }) } };
      if (id === "@/lib/i18n") return { default: { t: (_key: string, opts: { defaultValue: string }) => opts.defaultValue }, __esModule: true };
      if (id === "@/lib/asset-upload") return {};
      return require(id);
    }, module, module.exports,
  );
  const store = module.exports.useUserAssetStore;
  store.setState({ assets: [{ id: "asset", sizeBytes: 100, folderId: "folder" }] as UserAsset[], total: 1, storage: { used: 100, limit: 1000 } });
  return { store, errors };
}

for (const code of ["ASSET_VERSIONED", "ASSET_IN_USE"]) {
  test(`${code} explains why deletion is blocked without offering a futile retry`, async () => {
    const { store, errors } = loadStore();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ code, worlds: [{ name: "My card" }] }, { status: 409 });
    try {
      assert.equal(await store.getState().deleteAsset("asset"), false);
      assert.equal(store.getState().assets.length, 1);
      assert.equal(errors.length, 1);
      assert.match(errors[0]!.message, code === "ASSET_VERSIONED" ? /saved card history/i : /cover/i);
      assert.equal(errors[0]!.action, undefined);
    } finally { globalThis.fetch = originalFetch; }
  });
}

for (const outcome of ["success", "http", "network"] as const) {
  test(`asset deletion reports ${outcome} accurately and only removes confirmed deletions`, async () => {
    const { store, errors } = loadStore();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/user-assets/asset");
      assert.equal(init?.method, "DELETE");
      assert.equal(init?.credentials, "include");
      if (outcome === "network") throw new Error("offline");
      return Response.json(outcome === "success" ? { data: { deleted: true } } : { error: "Denied" }, { status: outcome === "success" ? 200 : 403 });
    };
    try {
      assert.equal(await store.getState().deleteAsset("asset"), outcome === "success");
      assert.equal(store.getState().assets.length, outcome === "success" ? 0 : 1);
      assert.equal(store.getState().storage.used, outcome === "success" ? 0 : 100);
      assert.equal(store.getState().total, outcome === "success" ? 0 : 1);
      assert.equal(errors.length, outcome === "success" ? 0 : 1);
    } finally { globalThis.fetch = originalFetch; }
  });
}
