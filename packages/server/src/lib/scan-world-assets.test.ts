import assert from "node:assert/strict";
import { test } from "node:test";
import { scanWorldForAssets } from "./scan-world-assets.js";
test("moderation includes dedicated landscape artwork even with extensionless CDN URLs", () => {
  for (const landscapeCover of ["worlds/abc/thumbnail/image.webp", "https://example.invalid/cdn/key/d29ybGRzL2FydA"]) {
    const found = scanWorldForAssets({ schema: { landscapeCover } }).find(a => a.location === "schema.landscapeCover");
    assert.ok(found?.resolvedUrl);
    assert.equal(found.raw, landscapeCover);
    assert.equal(found.source, "thumbnail");
  }
});
