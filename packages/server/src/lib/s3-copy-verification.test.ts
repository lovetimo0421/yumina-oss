import assert from "node:assert/strict";
import test from "node:test";
import { copyAndVerifyObject, type CopiedObjectMetadata } from "./s3-copy-verification.js";

function providerIgnoringCondition(source: CopiedObjectMetadata) {
  let destination: CopiedObjectMetadata | undefined;
  return {
    copy: async () => { destination = { ...source }; },
    head: async () => { assert.ok(destination, "HEAD must follow copy"); return destination; },
  };
}

const original = { etag: "original", contentLength: 100, contentType: "image/png" };

test("rejects a copied replacement when the provider ignores CopySourceIfMatch", async () => {
  const provider = providerIgnoringCondition({ ...original, etag: "replacement" });
  await assert.rejects(copyAndVerifyObject(provider.copy, provider.head, original), /changed during registration/);
});

test("accepts the verified immutable destination when source has not changed", async () => {
  const provider = providerIgnoringCondition({ ...original, etag: '\"original\"' });
  await copyAndVerifyObject(provider.copy, provider.head, original);
});

test("rejects metadata substitutions even when the ETag is unchanged", async () => {
  for (const source of [{ ...original, contentLength: 101 }, { ...original, contentType: "text/html" }]) {
    const provider = providerIgnoringCondition(source);
    await assert.rejects(copyAndVerifyObject(provider.copy, provider.head, original), /changed during registration/);
  }
});

test("rejects a destination without a verifiable ETag", async () => {
  const provider = providerIgnoringCondition({ ...original, etag: null });
  await assert.rejects(copyAndVerifyObject(provider.copy, provider.head, original), /changed during registration/);
});

test("a failed copy never attempts verification", async () => {
  await assert.rejects(copyAndVerifyObject(async () => { throw new Error("copy failed"); },
    async () => assert.fail("HEAD after failed copy"), original), /copy failed/);
});


test("pins the safe destination MIME during copy before it can be publicly read", async () => {
  let destination: CopiedObjectMetadata | undefined;
  await copyAndVerifyObject(async (metadata) => {
    assert.deepEqual(metadata, { MetadataDirective: "REPLACE", ContentType: "image/png" });
    // Source bytes did not change, but its MIME was swapped after inspection.
    const source = { ...original, contentType: "text/html" };
    destination = { ...source, contentType: metadata!.ContentType };
  }, async () => { assert.ok(destination); return destination; }, original);
  assert.equal(destination!.contentType, "image/png");
});

test("ETag-only verification does not replace existing metadata", async () => {
  await copyAndVerifyObject(async (metadata) => { assert.equal(metadata, undefined); },
    async () => original, { etag: original.etag });
});
