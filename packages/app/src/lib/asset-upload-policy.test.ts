import assert from "node:assert/strict";
import { test } from "node:test";
import { runUploadBatch, fetchUploadConcurrency } from "./asset-upload-policy";

test("batch workers obey the cap without skipping or duplicating files", async () => {
  for (const cap of [2,4,6]) {
    let live=0, maximum=0;
    const completed:number[]=[];
    await runUploadBatch(Array.from({length:25},(_,i)=>i),cap,async item=>{
      maximum=Math.max(maximum,++live);
      await new Promise<void>(resolve=>setImmediate(resolve));
      completed.push(item); live--;
    });
    assert.equal(maximum,cap);
    assert.equal(new Set(completed).size,25);
  }
});

test("policy lookup honors only supported server values and respects cancellation", async () => {
  const previous=globalThis.fetch;
  try {
    for (const cap of [2,4,6,100]) {
      globalThis.fetch=async()=>Response.json({data:{concurrency:cap}});
      assert.equal(await fetchUploadConcurrency(),cap===100?2:cap);
    }
    globalThis.fetch=async()=>{throw new Error("offline");};
    assert.equal(await fetchUploadConcurrency(),2);
    const controller=new AbortController(); controller.abort();
    await assert.rejects(fetchUploadConcurrency(controller.signal));
  } finally {globalThis.fetch=previous;}
});
