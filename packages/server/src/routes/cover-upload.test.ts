import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { Hono } from "hono";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, assets, userAssets, worldPendingEdits, worldReviewSubmissions } from "../db/schema.js";
import * as storage from "../lib/s3.js";
import { coverMotionKey } from "../lib/cover-upload.js";

const objects = new Map<string, { bytes: Buffer; type: string }>();
const signed: { key: string; type: string; length: number }[] = [];
mock.module(new URL("../lib/s3.ts", import.meta.url).href, { namedExports: { ...storage,
  isS3Configured: () => true,
  generateUploadUrl: async (key: string, type: string, options: {contentLength: number}) => {
    signed.push({key,type,length:options.contentLength}); return "https://storage.test/upload";
  },
  headObject: async (key: string) => {
    const object = objects.get(key);
    if (!object) throw Object.assign(new Error("missing"), {$metadata:{httpStatusCode:404}});
    return {contentType:object.type,contentLength:object.bytes.length,etag:"fixture"};
  },
  getObjectBufferLimited: async (key: string, limit: number) => {
    const object = objects.get(key)!; assert.ok(object.bytes.length <= limit); return object.bytes;
  },
  putObject: async (key: string, bytes: Buffer, type: string) => { objects.set(key,{bytes,type}); },
  deleteObject: async (key: string) => { objects.delete(key); },
} });
const { assetRoutes } = await import("./assets.js");
const { auth } = await import("../lib/auth.js");
const { getPendingEdit } = await import("../lib/pending-edit.js");
const app = new Hono().route("/api", assetRoutes);
const crop = {x:0,y:0,zoom:1,fit:"cover"};
const request = (world: string, path: string, body: object, actor = "cover-owner") => app.request(`/api/worlds/${world}/thumbnail${path}`, {
  method:"POST",headers:{"Content-Type":"application/json","x-test-user":actor},body:JSON.stringify({processingMode:"async",...body}),
});
async function complete(world: string, path: string, body: object) {
  for (let n=0;n<1000;n++) {
    const response = await request(world,path,body);
    if (response.status !== 202) { assert.equal(response.status,200,await response.clone().text()); return (await response.json() as any).data; }
    assert.equal((await response.json() as any).code,"COVER_PROCESSING");
    await wait(30);
  }
  assert.fail("cover processing did not finish");
}

test("video upload and library selection preserve ownership, crop targets and published review holds", async t => {
  t.mock.method(process,"availableMemory",()=>4*1024**3);
  t.mock.method(auth.api,"getSession",async ({headers}:{headers:Headers}) => {
    const id=headers.get("x-test-user"); return id ? {user:{id},session:{id:"session",userId:id,expiresAt:new Date(Date.now()+60_000),token:"fixture"}} : null;
  });
  await db.insert(user).values([
    {id:"cover-owner",name:"Owner",email:"cover-owner@test.invalid",role:"admin",birthYear:1990},
    {id:"cover-other",name:"Other",email:"cover-other@test.invalid",birthYear:1990},
  ]);
  for (const [id, published] of [["video-draft",false],["video-public",true]] as const) {
    await db.insert(worlds).values({id,creatorId:"cover-owner",name:id,status:published?"published":"draft",isPublished:published,
      visibility:published?"public":"private",language:"en",thumbnailUrl:"old.webp",schema:{version:"21.0.0",entries:[],coverCrop:crop,landscapeCover:"old-wide.webp",landscapeCoverCrop:crop}});
  }
  assert.equal((await request("video-draft","",{filename:"c.mp4",contentType:"video/mp4",sizeBytes:65*1024**2})).status,413);
  assert.equal((await request("video-draft","",{filename:"c.mp4",contentType:"video/mp4",sizeBytes:64*1024**2},"cover-other")).status,404);
  assert.equal((await request("video-draft","",{filename:"c.mp3",contentType:"audio/mpeg",sizeBytes:100})).status,400);
  const preparation = await request("video-draft","",{filename:"c.mp4",contentType:"video/mp4",sizeBytes:50*1024**2});
  assert.equal(preparation.status,200);
  const key = (await preparation.json() as any).data.key as string;
  assert.deepEqual(signed.at(-1),{key,type:"video/mp4",length:50*1024**2});
  const directory=await mkdtemp(join(tmpdir(),"yumina-cover-route-"));
  try {
    const file=join(directory,"input.mp4");
    await promisify(execFile)("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=848x480:rate=32:duration=5","-c:v","libx264","-threads","2","-pix_fmt","yuv420p","-y",file]);
    const video=await readFile(file);
    objects.set(key,{bytes:video,type:"video/mp4"});
    assert.equal((await request("video-draft","/confirm",{key},"cover-other")).status,404);
    const pending=await request("video-draft","/confirm",{key,target:"portrait"});
    assert.equal(pending.status,202);
    assert.equal((await db.select().from(worlds).where(eq(worlds.id,"video-draft")))[0]!.thumbnailUrl,"old.webp");
    const first=await complete("video-draft","/confirm",{key,target:"portrait"});
    assert.equal(objects.has(key),false,"temporary source removed only after the world update");
    const draft=(await db.select().from(worlds).where(eq(worlds.id,"video-draft")))[0]!;
    assert.ok(draft.thumbnailUrl!.endsWith(".motion.anim.image"));
    assert.ok(objects.has(coverMotionKey(draft.thumbnailUrl!)));
    assert.deepEqual(draft.schema.landscapeCoverCrop,crop);
    assert.equal(draft.schema.coverCrop,undefined);
    await db.update(worlds).set({schema:{...draft.schema,coverCrop:crop}}).where(eq(worlds.id,"video-draft"));
    const retried=await complete("video-draft","/confirm",{key,target:"portrait"});
    assert.equal(retried.thumbnailUrl,first.thumbnailUrl,"retry survives deleted temporary input");
    assert.equal(retried.updatedAt,first.updatedAt,"retry does not change the world's save revision");
    assert.deepEqual((await db.select().from(worlds).where(eq(worlds.id,"video-draft")))[0]!.schema.coverCrop,crop,"retry never clears a subsequently saved crop");

    await db.insert(assets).values({id:"generated-clip",worldId:"video-public",type:"video",filename:"generated.mp4",url:"library/source.mp4"});
    objects.set("library/source.mp4",{bytes:video,type:"video/mp4"});
    await db.insert(userAssets).values({id:"private-other-video",userId:"cover-other",type:"video",filename:"private.mp4",url:"private.mp4"});
    assert.equal((await request("video-draft","/from-asset",{assetId:"generated-clip"})).status,404);
    assert.equal((await request("video-public","/from-asset",{assetId:"private-other-video"})).status,404);
    const selected=await complete("video-public","/from-asset",{assetId:"generated-clip",target:"landscape"});
    assert.equal(selected.heldForReview,true);
    assert.ok(objects.has("library/source.mp4"),"selecting a library video preserves the source");
    const live=(await db.select().from(worlds).where(eq(worlds.id,"video-public")))[0]!;
    assert.equal(live.thumbnailUrl,"old.webp"); assert.equal(live.schema.landscapeCover,"old-wide.webp");
    const held=await getPendingEdit("video-public");
    assert.ok(String(held?.schema.landscapeCover).endsWith(".motion.anim.image"));
    assert.equal(held?.schema.landscapeCoverCrop,undefined);
    assert.deepEqual(held?.schema.coverCrop,crop);

    const submittedAt = new Date(Date.parse(selected.updatedAt) + 2000);
    await db.update(worldPendingEdits).set({ schema: {...held!.schema,landscapeCoverCrop:crop}, status:"pending", submittedAt, updatedAt:submittedAt })
      .where(eq(worldPendingEdits.worldId,"video-public"));
    await db.update(worlds).set({updatedAt:submittedAt}).where(eq(worlds.id,"video-public"));
    const [submission] = await db.insert(worldReviewSubmissions).values({ worldId:"video-public",groupKey:"video-public",submittedBy:"cover-owner",submissionType:"edit",decision:"pending",submittedAt }).returning();
    const submittedEdit = await getPendingEdit("video-public");
    const submittedRetry = await complete("video-public","/from-asset",{assetId:"generated-clip",target:"landscape"});
    assert.equal(submittedRetry.thumbnailUrl,selected.thumbnailUrl);
    assert.equal(submittedRetry.heldForReview,true);
    assert.equal(submittedRetry.updatedAt,submittedAt.toISOString(),"retry preserves the submitted world's save revision");
    assert.deepEqual(await getPendingEdit("video-public"),submittedEdit,"retry preserves the submitted cover's crop and review state");
    assert.deepEqual((await db.select().from(worldReviewSubmissions).where(eq(worldReviewSubmissions.id,submission!.id)))[0],submission,"retry must not withdraw the pending review");
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("legacy upload and library callers receive completed data without opting into polling", async t => {
  t.mock.method(process,"availableMemory",()=>4*1024**3);
  t.mock.method(auth.api,"getSession",async ({headers}:{headers:Headers}) => {
    const id=headers.get("x-test-user"); return id ? {user:{id},session:{id:"session",userId:id,expiresAt:new Date(Date.now()+60_000),token:"fixture"}} : null;
  });
  const owner = "legacy-cover-owner", world = "legacy-cover-world";
  await db.insert(user).values({id:owner,name:"Legacy owner",email:"legacy-cover@test.invalid",role:"admin",birthYear:1990});
  await db.insert(worlds).values({id:world,creatorId:owner,name:world,status:"draft",isPublished:false,visibility:"private",language:"en",thumbnailUrl:"old.webp",schema:{version:"21.0.0",entries:[]}});
  const bytes = await sharp({create:{width:16,height:24,channels:3,background:"red"}}).png().toBuffer();
  const key = `worlds/${world}/thumbnail/pending/legacy.png`;
  objects.set(key,{bytes,type:"image/png"});
  const confirmed = await request(world,"/confirm",{key,processingMode:undefined},owner);
  assert.equal(confirmed.status,200,await confirmed.clone().text());
  const confirmedData = (await confirmed.json() as any).data;
  assert.equal(typeof confirmedData.thumbnailUrl,"string");
  assert.equal(typeof confirmedData.updatedAt,"string");
  assert.equal(objects.has(key),false,"legacy confirmation finishes the world update and source cleanup");

  const assetId = "legacy-cover-asset", source = "library/legacy-cover.png";
  objects.set(source,{bytes,type:"image/png"});
  await db.insert(assets).values({id:assetId,worldId:world,type:"image",filename:"legacy.png",url:source});
  const selected = await request(world,"/from-asset",{assetId,processingMode:undefined},owner);
  assert.equal(selected.status,200,await selected.clone().text());
  const selectedData = (await selected.json() as any).data;
  assert.equal(typeof selectedData.thumbnailUrl,"string");
  assert.equal(typeof selectedData.updatedAt,"string");
  assert.notEqual(selectedData.thumbnailUrl,confirmedData.thumbnailUrl);
  assert.equal(objects.has(source),true,"library selection keeps the source");
});
