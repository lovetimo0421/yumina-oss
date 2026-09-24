import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import type { Hono, Context } from "hono";
import { PGlite } from "@electric-sql/pglite";
import * as database from "../db/index.js";
import type { AppEnv } from "../lib/types.js";

// Actual route and PostgreSQL conflict semantics, isolated by test-local.mjs.
// Auth and object transport are the only external boundaries replaced here.
let owner = "alice", signedUrls = 0;
const file = new URL("./user-assets.ts", import.meta.url);
const require = createRequire(file);
const module = { exports: {} as { userAssetRoutes: Hono<AppEnv> } };
const mocks: Record<string, unknown> = {
  "../db/index.js": database,
  "../middleware/auth.js": { authMiddleware: async (c: Context<AppEnv>, next: () => Promise<void>) => { c.set("user", { id: owner } as AppEnv["Variables"]["user"]); await next(); } },
  "../lib/s3.js": { isS3Configured: () => true, generateUploadUrl: async () => { signedUrls++; return "https://storage.test/upload"; }, deleteObject: async () => {} },
  "../lib/credit-service.js": { ensureWallet: async () => ({ plan: "free" }) },
  "../lib/event-plan-entitlements.js": { resolveEffectivePlanWithEventEntitlements: async () => "free" },
  "../lib/plan-config.js": { PLANS: { free: { storageCap: 100 } } },
  "../lib/image-resize.js": { resizeUploadedImageInBackground: () => {} },
  "../lib/generation/asset-receipts.js": { detachGenerationAsset: async () => {} },
};
new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
const routes = module.exports.userAssetRoutes;
const client = database.db.$client as PGlite;
before(async () => {
  assert.ok(client instanceof PGlite);
  await client.exec(`
    CREATE TABLE asset_folders (id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, parent_folder_id text, created_at timestamp DEFAULT now());
    CREATE TABLE user_assets (id text PRIMARY KEY, user_id text NOT NULL, type text NOT NULL, filename text NOT NULL, url text NOT NULL, size_bytes integer, mime_type text, folder_id text REFERENCES asset_folders(id), source_asset_id text, is_public boolean DEFAULT false, created_at timestamp DEFAULT now());
  `);
});
const post = (path: string, body: object) => routes.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const data = async (response: Response) => (await response.json() as { data: { id: string; key: string; asset?: { id: string } } }).data;

test("lost responses and concurrent retries produce one folder and asset, even near quota", async () => {
  owner = "alice";
  const folderRequest = { name: "clips", requestId: crypto.randomUUID() };
  const folders = await Promise.all([post("/folders", folderRequest), post("/folders", folderRequest)]);
  assert.ok(folders.every(response => response.status === 201));
  const folder = await data(folders[0]!);
  assert.equal((await data(folders[1]!)).id, folder.id);
  const request = { requestId: crypto.randomUUID(), filename: "scene.webm", type: "video", contentType: "", sizeBytes: 60 };
  const prepared = await post("/upload-url", request);
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const key = (await data(prepared)).key;
  const body = { ...request, key, mimeType: "video/webm", folderId: folder.id };
  const registered = await Promise.all([post("/", body), post("/", body)]);
  assert.ok(registered.every(response => response.status === 201));
  const asset = await data(registered[0]!);
  assert.equal((await data(registered[1]!)).id, asset.id);
  // Treat the successful responses as lost; retry prepare at 60/100 used.
  const retried = await post("/upload-url", request);
  assert.equal(retried.status, 200);
  assert.equal((await data(retried)).asset?.id, asset.id);
  assert.equal(signedUrls, 1, "committed asset is reconciled without another storage transfer");
  const { rows } = await client.query<{ count: number; bytes: number }>("SELECT count(*)::int AS count, sum(size_bytes)::int AS bytes FROM user_assets");
  assert.deepEqual(rows, [{ count: 1, bytes: 60 }]);
  assert.equal((await post("/upload-url", { ...request, requestId: crypto.randomUUID() })).status, 400, "new bytes remain quota-gated");
  owner = "bob";
  assert.equal((await post("/folders", { name: "private", parentFolderId: folder.id })).status, 404);
  assert.equal((await post("/", body)).status, 400, "another account cannot register the first owner's key");
  const other = await post("/upload-url", request);
  assert.equal(other.status, 200);
  const otherData = await data(other);
  assert.equal(otherData.asset, undefined);
  assert.notEqual(otherData.key, key);
});

test("video MIME checks reject active or unsupported content", async () => {
  owner = "charlie";
  for (const contentType of ["text/html", "video/quicktime"]) {
    const response = await post("/upload-url", { filename: "clip.mp4", type: "video", contentType });
    assert.equal(response.status, 400);
  }
  assert.equal((await post("/upload-url", { filename: "clip.MP4", type: "video", contentType: "application/octet-stream", sizeBytes: 1 })).status, 200);
});
