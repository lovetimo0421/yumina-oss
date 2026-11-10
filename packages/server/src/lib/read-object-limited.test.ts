import assert from "node:assert/strict";
import { test } from "node:test";
import { readObjectBodyLimited } from "./read-object-limited.js";

test("oversized headers and oversized streams both close the object response", async () => {
  for (const header of [1000, 1, undefined]) {
    let closed=false, reads=0;
    const body={destroy(){closed=true;},async *[Symbol.asyncIterator](){reads++;yield Buffer.alloc(6);yield Buffer.alloc(6);}};
    await assert.rejects(readObjectBodyLimited(body,header,10),/MEDIA_INVALID_SIZE/);
    assert.equal(closed,true);
    assert.equal(reads,header===1000?0:1);
  }
});

test("bounded reader preserves exact bytes and closes successful responses", async () => {
  let closed=false;
  const body={destroy(){closed=true;},async *[Symbol.asyncIterator](){yield Buffer.from("hello");yield Buffer.from("world");}};
  assert.equal((await readObjectBodyLimited(body,10,10)).toString(),"helloworld");
  assert.equal(closed,true);
});
