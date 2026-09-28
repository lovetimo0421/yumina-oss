import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import type { Hono, Context } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DrizzleDB } from "../db/index.js";
import { SESSION_MEDIA_DDL } from "../db/session-media-ddl.js";
import { createSessionMediaService } from "../lib/session-media-service.js";
import { uploadOperationId } from "../lib/asset-upload-operation.js";
import type { AppEnv } from "../lib/types.js";

// Actual route and PostgreSQL semantics, with no runtime database/env import.
// Only auth, entitlement lookup and object transport cross mocked boundaries.
let owner = "alice", signedUrls = 0;
let backend: "local" | "s3" = "local", copies = 0, headCalls = 0;
let alterCopiedMime = false;
const client = new PGlite();
const database = { db: drizzle(client) as unknown as DrizzleDB };
const objects = new Map<string, {contentType:string;contentLength:number;etag:string}>();
const service = createSessionMediaService(database.db, {
  signUpload: async key => key, signRead: async key => key,
  read: async () => Buffer.alloc(0), write: async () => {},
  remove: async key => { objects.delete(key); },
});
const file = new URL("./user-assets.ts", import.meta.url);
const require = createRequire(file);
const module = { exports: {} as { userAssetRoutes: Hono<AppEnv> } };
const mocks: Record<string, unknown> = {
  "../db/index.js": database,
  "../middleware/auth.js": { authMiddleware: async (c: Context<AppEnv>, next: () => Promise<void>) => { c.set("user", { id: owner } as AppEnv["Variables"]["user"]); await next(); } },
  "../lib/s3.js": {
    isS3Configured: () => true, storageKind: () => backend,
    generateUploadUrl: async (_key:string, _mime:string, options?:{contentLength:number;expiresIn:number}) => {
      signedUrls++;
      if (backend === "s3") {
        assert.ok(options && options.contentLength > 0);
        assert.ok(options.expiresIn > 0 && options.expiresIn <= 600);
      }
      return "https://storage.test/upload";
    },
    headObject: async (key:string) => {
      headCalls++;
      const object = objects.get(key);
      assert.ok(object, "HEAD must inspect an uploaded object");
      return object;
    },
    copyObject: async (source:string, destination:string, etag?:string, expected?:{contentLength:number;contentType:string}) => {
      const object = objects.get(source);
      assert.ok(object);
      assert.equal(etag, object.etag, "copy must be conditional on inspected content");
      copies++;
      objects.set(destination, {...object, ...(alterCopiedMime ? {contentType:"text/html"} : {})});
      assert.deepEqual(expected, object, "registration supplies inspected metadata to the copy integrity check");
      if (objects.get(destination)!.contentType !== expected!.contentType) throw new Error("Copied object metadata changed");
    },
    deleteObject: async (key:string) => { objects.delete(key); },
  },
  "../lib/session-media.js": { sessionMedia: service },
  "../lib/env.js": { env: { BETTER_AUTH_URL: "https://yumina.test" } },
  "../lib/credit-service.js": { ensureWallet: async () => ({ plan: "free" }) },
  "../lib/event-plan-entitlements.js": { resolveEffectivePlanWithEventEntitlements: async () => "free" },
  "../lib/plan-config.js": { PLANS: { free: { storageCap: 100 } } },
  "../lib/image-resize.js": { resizeUploadedImageInBackground: () => {} },
  "../lib/generation/asset-receipts.js": { detachGenerationAsset: async () => {} },
};
new Function("require", "module", "exports", transform(readFileSync(file, "utf8"), { transforms: ["typescript", "imports"] }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
const routes = module.exports.userAssetRoutes;
before(async () => {
  assert.ok(client instanceof PGlite);
  await client.exec(`
    CREATE TABLE "user" (id text PRIMARY KEY);
    INSERT INTO "user" VALUES ('alice'),('bob'),('charlie'),('dana'),('erin'),('frank');
    CREATE TABLE play_sessions(id text PRIMARY KEY,user_id text,parent_session_id text,branched_from_message_id text);
    CREATE TABLE messages(id text PRIMARY KEY,session_id text,created_at timestamp);
    CREATE TABLE checkpoints(id text PRIMARY KEY,session_id text);
    CREATE TABLE shared_playthroughs(id text PRIMARY KEY,source_session_id text,sharer_user_id text);
    CREATE TABLE asset_folders (id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, parent_folder_id text, created_at timestamp DEFAULT now());
    CREATE TABLE user_assets (id text PRIMARY KEY, user_id text NOT NULL, type text NOT NULL, filename text NOT NULL, url text NOT NULL, size_bytes integer, mime_type text, folder_id text REFERENCES asset_folders(id), source_asset_id text, is_public boolean DEFAULT false, created_at timestamp DEFAULT now());
  `);
});
after(async () => { await client.close(); });
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
  objects.set(key, {contentType:"video/webm",contentLength:60,etag:"local-original"});
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

test("staged retries reuse one reservation and settle one immutable asset using real bytes", async () => {
  await client.exec(SESSION_MEDIA_DDL);
  backend = "s3";
  owner = "dana";
  const request = {requestId:crypto.randomUUID(),filename:"scene.webm",type:"video",contentType:"video/webm",sizeBytes:60};
  const preparations = await Promise.all([post("/upload-url",request),post("/upload-url",request)]);
  assert.ok(preparations.every(response=>response.status===200));
  const key = (await data(preparations[0]!)).key;
  assert.equal((await data(preparations[1]!)).key,key,"lost prepare response reuses staged key");
  assert.ok(key.startsWith("private-session-media/dana/pending/"));
  assert.equal((await service.usage(owner)).reserved,60,"concurrent retries reserve bytes once");
  assert.equal((await post("/upload-url",{...request,filename:"different.webm"})).status,409);
  objects.set(key,{contentType:"video/webm",contentLength:60,etag:"staged-original"});
  const body = {...request,key,mimeType:"video/webm",sizeBytes:1};
  const beforeCopies = copies;
  const registered = await Promise.all([post("/",body),post("/",body)]);
  assert.ok(registered.every(response=>response.status===201),await registered[0]!.clone().text());
  const asset = await data(registered[0]!);
  assert.equal((await data(registered[1]!)).id,asset.id);
  assert.equal(asset.id,uploadOperationId(owner,"file",request.requestId));
  assert.equal(copies-beforeCopies,1,"concurrent confirmation makes only one final copy");
  assert.ok(asset.key.startsWith("users/dana/registered/"));
  assert.deepEqual(await service.usage(owner),{used:60,mediaBytes:0,reserved:0},"untrusted reported byte count is ignored");
  assert.equal((await post("/upload-url",{...request,requestId:crypto.randomUUID(),sizeBytes:50})).status,413);
  await client.exec(`UPDATE session_media_uploads SET expires_at=now()-interval '1 hour' WHERE user_id='dana'`);
  await service.sweep();
  assert.equal(objects.has(key),false);
  assert.equal(objects.has(asset.key),true,"cleanup keeps registered immutable file");
  const headsBeforeRetry = headCalls;
  assert.equal((await post("/",body)).status,201,"lost confirmation response survives temporary cleanup");
  assert.equal(headCalls,headsBeforeRetry,"completed confirmation does not HEAD cleaned staging object");
  assert.equal((await data(await post("/upload-url",request))).asset?.id,asset.id);
  await client.exec(`INSERT INTO session_media(id,user_id,filename,hash,object_key,thumbnail_key,size_bytes,width,height)
    VALUES ('private-dana','dana','private','private','private/main','private/thumb',30,1,1)`);
  assert.equal((await post("/upload-url",{...request,requestId:crypto.randomUUID(),sizeBytes:20})).status,413,"private media consumes the same account quota");
});

test("expired staging can retry with the same asset ID and changed object metadata cannot settle", async () => {
  owner = "erin";
  backend = "s3";
  const request = {requestId:crypto.randomUUID(),filename:"retry.webm",type:"video",contentType:"video/webm",sizeBytes:40};
  const original = await data(await post("/upload-url",request));
  await client.exec(`UPDATE session_media_uploads SET expires_at=now()-interval '1 hour' WHERE user_id='erin'`);
  await service.sweep();
  const retry = await data(await post("/upload-url",request));
  assert.notEqual(retry.key,original.key,"expired staging is replaced without extending old PUT access");
  assert.equal((await service.usage(owner)).reserved,40);
  const body = {...request,key:retry.key,mimeType:"video/webm"};
  objects.set(retry.key,{contentType:"video/webm",contentLength:41,etag:"size-mismatch"});
  assert.equal((await post("/",body)).status,409,"HEAD size must match reservation");
  objects.set(retry.key,{contentType:"text/html",contentLength:40,etag:"mime-mismatch"});
  assert.equal((await post("/",body)).status,400,"HEAD MIME must match prepared type");
  objects.set(retry.key,{contentType:"video/webm",contentLength:40,etag:"valid"});
  alterCopiedMime=true;
  try {
    assert.equal((await post("/",body)).status,500,"post-copy MIME mutation never becomes a public asset");
    assert.equal((await service.usage(owner)).used,0);
  } finally { alterCopiedMime=false; }
  const registered = await post("/",body);
  assert.equal(registered.status,201,await registered.clone().text());
  assert.equal((await data(registered)).id,uploadOperationId(owner,"file",request.requestId));
  assert.deepEqual(await service.usage(owner),{used:40,mediaBytes:0,reserved:0});
});

test("local creative uploads remain available after private media schema installation", async () => {
  owner = "frank";
  backend = "local";
  const request = {requestId:crypto.randomUUID(),filename:"local.webm",type:"video",contentType:"video/webm",sizeBytes:10};
  const prepared = await post("/upload-url",request);
  assert.equal(prepared.status,200,await prepared.clone().text());
  const key = (await data(prepared)).key;
  assert.ok(key.startsWith("users/frank/video/"));
  assert.equal((await service.usage(owner)).reserved,0);
  objects.set(key,{contentType:"video/webm",contentLength:12,etag:"local"});
  assert.equal((await post("/",{...request,key,mimeType:"video/webm"})).status,201);
  assert.equal((await service.usage(owner)).used,12,"local uploads also settle actual bytes");
});
