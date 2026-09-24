import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CHAT_IMAGE_BYTES, type ChatImageAttachment } from "@yumina/shared";
import { readChatAsset } from "./chat-asset-input";
import { readChatImages } from "./chat-image-input";

const asset: ChatImageAttachment = { type: "image", assetId: "123", name: "moon.png", mimeType: "image/png", url: "https://untrusted.example/thumbnail" };

test("library images use original CDN bytes and preserve existing composer limits", async () => {
  const originalFetch = globalThis.fetch;
  const originalReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  class Reader {
    result = "";
    onload = () => {};
    readAsDataURL(file: File) {
      void file.arrayBuffer().then(buffer => {
        this.result = `data:${file.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload();
      });
    }
  }
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: Reader });
  try {
    globalThis.fetch = (async (url, options) => {
      assert.equal(url, "/cdn/123", "Never fetch an arbitrary URL or a transformed thumbnail");
      assert.ok(options?.signal);
      return new Response("original bytes", { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const image = await readChatAsset(asset);
    assert.deepEqual(image, { type: "image", name: "moon.png", mimeType: "image/png", data: Buffer.from("original bytes").toString("base64") });
    await assert.rejects(readChatImages([], Array(5).fill(image)), /count/);
    await assert.rejects(readChatImages([], [{ ...image, data: "A".repeat(24 * 1024 * 1024) }]), /total/);

    globalThis.fetch = async () => new Response("missing", { status: 404 });
    await assert.rejects(readChatAsset(asset), /read/);
    globalThis.fetch = async () => new Response("vector", { headers: { "content-type": "image/svg+xml" } });
    await assert.rejects(readChatAsset(asset), /format/);
    globalThis.fetch = async () => new Response("", { headers: { "content-type": "image/png" } });
    await assert.rejects(readChatAsset(asset), /size/);
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_CHAT_IMAGE_BYTES + 1)); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(readChatAsset(asset), /size/);
    assert.equal(cancelled, true, "Oversized downloads stop without consuming the remaining body");
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (async (_url, options) => { options?.signal?.throwIfAborted(); throw new Error("unexpected"); }) as typeof fetch;
    await assert.rejects(readChatAsset(asset, controller.signal), { name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalReader) Object.defineProperty(globalThis, "FileReader", originalReader);
    else Reflect.deleteProperty(globalThis, "FileReader");
  }
});
