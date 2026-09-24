import assert from "node:assert/strict";
import test from "node:test";
import { uploadOperationId, validUploadRequestId } from "./asset-upload-operation.js";
import { normalizeAssetMimeType } from "./asset-mime.js";

test("retry identity is stable, scoped by account and kind, and compatible with asset references", () => {
  const request = "caf91e2f-75d1-4039-9cee-c0d5fdc34f41";
  const id = uploadOperationId("alice", "file", request);
  assert.equal(id, uploadOperationId("alice", "file", request));
  assert.notEqual(id, uploadOperationId("bob", "file", request));
  assert.notEqual(id, uploadOperationId("alice", "folder", request));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(validUploadRequestId(request), true);
  assert.equal(validUploadRequestId(undefined), true);
  for (const value of [null, 1, {}, "../../asset", "x".repeat(1000)]) assert.equal(validUploadRequestId(value), false);
});

test("video upload inference agrees for empty and generic MIME types", () => {
  assert.equal(normalizeAssetMimeType("clip.MP4", ""), "video/mp4");
  assert.equal(normalizeAssetMimeType("clip.webm", "application/octet-stream"), "video/webm");
});
