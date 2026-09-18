import assert from "node:assert/strict";
import test from "node:test";
import { cardImageUrl, originalImageUrl, fallbackToOriginalOnError } from "./asset-url";

// Guards the CF Image Transformations contract (see cardImageUrl doc comment):
// quality=85 (Cloudflare's default — 82 read visibly worse on DPR-1 monitors),
// onerror=redirect so a failed transform serves the original, and no
// double-wrapping so passing an already-transformed URL through is a no-op.

test("cardImageUrl builds a transform URL at quality=85", () => {
  assert.equal(
    cardImageUrl("/cdn/some-asset-id", 480),
    "/cdn-cgi/image/width=480,quality=85,format=auto,onerror=redirect/cdn/some-asset-id",
  );
});

test("cardImageUrl resolves bare uuid refs onto /cdn/ before wrapping", () => {
  const uuid = "2232e6b0-132b-41b8-ad1b-78c6a37f8f96";
  assert.equal(
    cardImageUrl(uuid, 300),
    `/cdn-cgi/image/width=300,quality=85,format=auto,onerror=redirect/cdn/${uuid}`,
  );
});

test("cardImageUrl never double-wraps an already-transformed URL", () => {
  const once = cardImageUrl("/cdn/some-asset-id", 480)!;
  assert.equal(cardImageUrl(once, 896), once);
});

test("originalImageUrl undoes the transform prefix", () => {
  const once = cardImageUrl("/cdn/some-asset-id", 480)!;
  assert.equal(originalImageUrl(once), "/cdn/some-asset-id");
});

test("cardImageUrl passes foreign/data URLs through untouched", () => {
  assert.equal(cardImageUrl("data:image/png;base64,xyz"), "data:image/png;base64,xyz");
  assert.equal(cardImageUrl("https://elsewhere.example/img.png"), "https://elsewhere.example/img.png");
});

// Off Cloudflare (local dev, or transformations disabled) /cdn-cgi/image/* 404s,
// and onerror=redirect cannot help because the edge never runs. Plain <img> tags
// need this handler or every library thumbnail renders broken.
test("fallbackToOriginalOnError swaps a failed transform back to the original", () => {
  const img = { src: cardImageUrl("/cdn/some-asset-id", 400)! } as HTMLImageElement;
  fallbackToOriginalOnError({ currentTarget: img });
  assert.equal(img.src, "/cdn/some-asset-id");
});

test("fallbackToOriginalOnError does not loop on an untransformed src", () => {
  const img = { src: "/cdn/some-asset-id" } as HTMLImageElement;
  fallbackToOriginalOnError({ currentTarget: img });
  assert.equal(img.src, "/cdn/some-asset-id", "a genuinely broken image must fail once, not retry forever");
});
