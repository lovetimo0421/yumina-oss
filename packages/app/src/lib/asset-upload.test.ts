import test from "node:test";
import assert from "node:assert/strict";
import {
  AssetUploadError,
  getUploadMetadata,
  isAnimatedImageFile,
  uploadAssetWithPresignedUrl,
} from "./asset-upload";
import { createUploadTestPng, PNG_SIGNATURE, pngChunk } from "./test-fixtures/upload-png";

test("video inference recognizes MP4 and WebM without browser metadata", () => {
  assert.deepEqual(getUploadMetadata(new File(["video"], "scene.MP4")), { type: "video", contentType: "video/mp4" });
  assert.deepEqual(getUploadMetadata(new File(["video"], "scene.webm", { type: "application/octet-stream" })), { type: "video", contentType: "video/webm" });
});

test("browser transfer emits byte progress and aborts immediately without retry or registration", async () => {
  const oldFetch = globalThis.fetch;
  const oldXhr = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  const controller = new AbortController();
  let aborted = false, sent = 0, requests = 0, loaded = 0;
  class FakeXhr extends EventTarget {
    upload = new EventTarget(); timeout = 0;
    open() {} setRequestHeader() {}
    send() {
      sent++;
      this.upload.dispatchEvent(new Event("loadstart"));
      const progress = new Event("progress");
      Object.assign(progress, { lengthComputable: true, loaded: 5, total: 10 });
      this.upload.dispatchEvent(progress);
    }
    abort() { aborted = true; this.dispatchEvent(new Event("abort")); this.dispatchEvent(new Event("loadend")); }
  }
  globalThis.fetch = async () => { requests++; return Response.json({ data: { uploadUrl: "/storage", key: "key" } }); };
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FakeXhr });
  try {
    const run = uploadAssetWithPresignedUrl({ file: new File(["1234567890"], "a.txt"), prepareUrl: "/prepare", registerUrl: "/register", registerBody: {}, signal: controller.signal,
      onProgress: progress => { loaded = progress.loaded; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(loaded, 5);
    controller.abort(); await assert.rejects(run);
    assert.equal(aborted, true); assert.equal(sent, 1); assert.equal(requests, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldXhr) Object.defineProperty(globalThis, "XMLHttpRequest", oldXhr); else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  }
});

test("prepare timeout is bounded and cancellation never advances to storage", async () => {
  const config = { file: new File(["a"], "a.txt"), prepareUrl: "/prepare", registerUrl: "/register", registerBody: {} };
  let requests = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests++;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  };
  await assert.rejects(uploadAssetWithPresignedUrl({ ...config, fetchImpl, prepareTimeoutMs: 5 }), (error: unknown) => error instanceof AssetUploadError && error.stage === "prepare");
  const controller = new AbortController();
  const run = uploadAssetWithPresignedUrl({ ...config, fetchImpl, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(run);
  assert.equal(requests, 2);
});

test("retry after a lost registration response reuses the committed asset without uploading again", async () => {
  let committed = false, transfers = 0, registrations = 0;
  const controller = new AbortController();
  const stages: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (input === "/prepare") return Response.json({ data: committed ? { asset: { id: "stable-id" } } : { uploadUrl: "/storage", key: "stable-key" } });
    if (input === "/storage") { transfers++; return new Response(null, { status: 200 }); }
    registrations++; committed = true;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      controller.abort();
    });
  };
  const config = { file: new File(["a"], "a.txt"), prepareUrl: "/prepare", registerUrl: "/register", registerBody: {}, fetchImpl, onStage: (stage: string) => stages.push(stage) };
  await assert.rejects(uploadAssetWithPresignedUrl({ ...config, signal: controller.signal }));
  assert.deepEqual(await uploadAssetWithPresignedUrl(config), { id: "stable-id" });
  assert.equal(transfers, 1); assert.equal(registrations, 1);
  assert.deepEqual(stages, ["prepare", "storage", "register", "prepare"]);
});

function pngFile(animated = false, metadata?: Buffer) {
  return new File([new Uint8Array(createUploadTestPng(animated, metadata))], "upload-test.png", { type: "image/png" });
}

test("animation detection handles large static PNGs and APNGs without argument overflow", async () => {
  const still = pngFile();
  const animated = pngFile(true);
  assert.ok(still.size > 256 * 1024);
  assert.ok(animated.size > 1024 * 1024);
  assert.equal(await isAnimatedImageFile(still), false);
  assert.equal(await isAnimatedImageFile(animated), true);
});

test("PNG animation detection follows chunks, not metadata strings", async () => {
  assert.equal(await isAnimatedImageFile(pngFile(false, Buffer.from("Comment\0acTL"))), false);
  assert.equal(await isAnimatedImageFile(pngFile(true, Buffer.from("Comment\0IDAT"))), true);
});

test("inconclusive or unreadable PNG headers remain unknown", async () => {
  assert.equal(await isAnimatedImageFile(pngFile(true, Buffer.alloc(300 * 1024))), null);
  const truncated = new Blob([PNG_SIGNATURE, new Uint8Array(pngChunk("tEXt", Buffer.alloc(10)).subarray(0, 9))], { type: "image/png" });
  assert.equal(await isAnimatedImageFile(truncated), null);
  const unreadable = pngFile();
  Object.defineProperty(unreadable, "slice", { value: () => { throw new Error("Cannot inspect"); } });
  assert.equal(await isAnimatedImageFile(unreadable), null);
});

test("GIF, JPEG and WebP animation detection keeps existing behavior", async () => {
  assert.equal(await isAnimatedImageFile(new Blob(["GIF89a"], { type: "image/gif" })), true);
  assert.equal(await isAnimatedImageFile(new Blob(["jpeg"], { type: "image/jpeg" })), false);
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0);
  webp.writeUInt32LE(22, 4);
  webp.write("WEBPVP8X", 8);
  webp.writeUInt32LE(10, 16);
  for (const animated of [false, true]) {
    webp[20] = animated ? 2 : 0;
    assert.equal(await isAnimatedImageFile(new Blob([webp], { type: "image/webp" })), animated);
  }
});

test("large, animated and unreadable PNGs complete the uploader with original bytes", async () => {
  const unreadable = pngFile(true);
  Object.defineProperty(unreadable, "slice", { value: () => { throw new Error("Cannot inspect"); } });
  for (const file of [pngFile(), pngFile(true), unreadable]) {
    const requests: { url: string; init?: RequestInit }[] = [];
    const result = await uploadAssetWithPresignedUrl({
      file,
      resizeImageMaxDimension: 100,
      prepareUrl: "https://test.invalid/prepare",
      registerUrl: "https://test.invalid/register",
      registerBody: ({ file: uploaded, key }) => ({ key, sizeBytes: uploaded.size }),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/prepare")) return Response.json({ data: { uploadUrl: "https://test.invalid/storage", key: "test" } });
        if (String(url).endsWith("/storage")) return new Response(null, { status: 200 });
        return Response.json({ data: { id: "asset" } }, { status: 201 });
      },
    });
    assert.deepEqual(result, { id: "asset" });
    assert.deepEqual(requests.map(r => r.init?.method), ["POST", "PUT", "POST"]);
    assert.equal(requests[1]!.init?.body, file);
    assert.equal(JSON.parse(String(requests[2]!.init?.body)).sizeBytes, file.size);
    assert.equal(JSON.parse(String(requests[0]!.init?.body)).animated, file === unreadable || file.size > 1024 * 1024 ? true : undefined);
  }
});

test("cover resizing runs only for proven still images", async () => {
  const originals = ["document", "createImageBitmap"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let decodes = 0;
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: () => ({
      getContext: () => ({ fillRect() {}, drawImage() {} }),
      toBlob: (done: (blob: Blob) => void) => done(new Blob(["resized"], { type: "image/jpeg" })),
    }),
  } });
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: async () => {
    decodes++;
    return { width: 512, height: 512, close() {} };
  } });
  try {
    const unknown = pngFile(true, Buffer.alloc(300 * 1024));
    const still = pngFile();
    for (const file of [still, pngFile(true), unknown]) {
      let uploaded: unknown;
      await uploadAssetWithPresignedUrl({
        file, resizeImageMaxDimension: 100,
        prepareUrl: "prepare", registerUrl: "register", registerBody: {},
        fetchImpl: async (url, init) => {
          if (url === "prepare") return Response.json({ data: { uploadUrl: "storage", key: "test" } });
          if (url === "storage") { uploaded = init?.body; return new Response(null); }
          return Response.json({ data: { id: "asset" } });
        },
      });
      if (file === still) {
        assert.ok(uploaded instanceof File);
        assert.equal(uploaded.type, "image/jpeg");
        assert.equal(uploaded.size, 7);
      } else assert.equal(uploaded, file);
    }
    assert.equal(decodes, 1, "animated and unknown files must never enter the canvas");
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("uploadAssetWithPresignedUrl completes prepare, storage, and register stages", async () => {
  const prepareUrl = "https://yumina.test/api/user-assets/upload-url";
  const storageUrl = "https://storage.example/upload";
  const registerUrl = "https://yumina.test/api/user-assets";
  const file = new File(["hello"], "background.png", { type: "image/png" });
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ input, init });

    if (input === prepareUrl) {
      return new Response(
        JSON.stringify({
          data: {
            uploadUrl: storageUrl,
            key: "users/demo/image/background.png",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (input === storageUrl) {
      return new Response(null, { status: 200 });
    }

    if (input === registerUrl) {
      return new Response(
        JSON.stringify({
          data: {
            id: "asset-1",
            filename: "background.png",
          },
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    throw new Error(`Unexpected fetch call: ${String(input)}`);
  };

  const result = await uploadAssetWithPresignedUrl<{ id: string; filename: string }>({
    file,
    prepareUrl,
    registerUrl,
    registerBody: ({ key, resolvedType, contentType }) => ({
      key,
      filename: file.name,
      type: resolvedType,
      mimeType: contentType,
      sizeBytes: file.size,
    }),
    fetchImpl: fetchMock,
  });

  assert.deepEqual(result, {
    id: "asset-1",
    filename: "background.png",
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.input, storageUrl);
  assert.deepEqual(calls[1]?.init?.headers, { "Content-Type": "image/png" });
});

test("uploadAssetWithPresignedUrl surfaces storage timeouts", async () => {
  const prepareUrl = "https://yumina.test/api/user-assets/upload-url";
  const storageUrl = "https://storage.example/upload";
  const registerUrl = "https://yumina.test/api/user-assets";
  const file = new File(["font"], "title.woff2", { type: "" });

  const fetchMock: typeof fetch = async (input, init) => {
    if (input === prepareUrl) {
      return new Response(
        JSON.stringify({
          data: {
            uploadUrl: storageUrl,
            key: "users/demo/font/title.woff2",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (input === storageUrl) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }

    throw new Error(`Unexpected fetch call: ${String(input)}`);
  };

  await assert.rejects(
    () =>
      uploadAssetWithPresignedUrl({
        file,
        preferredType: "font",
        prepareUrl,
        registerUrl,
        registerBody: { key: "unused" },
        fetchImpl: fetchMock,
        storageTimeoutMs: 5,
      }),
    (error: unknown) => {
      assert(error instanceof AssetUploadError);
      assert.equal(error.stage, "storage");
      assert.equal(error.message, "Upload to storage timed out");
      return true;
    }
  );
});

test("uploadAssetWithPresignedUrl surfaces register failures", async () => {
  const prepareUrl = "https://yumina.test/api/user-assets/upload-url";
  const storageUrl = "https://storage.example/upload";
  const registerUrl = "https://yumina.test/api/user-assets";
  const file = new File(["audio"], "theme.mp3", { type: "audio/mpeg" });

  const fetchMock: typeof fetch = async (input) => {
    if (input === prepareUrl) {
      return new Response(
        JSON.stringify({
          data: {
            uploadUrl: storageUrl,
            key: "users/demo/audio/theme.mp3",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (input === storageUrl) {
      return new Response(null, { status: 200 });
    }

    if (input === registerUrl) {
      return new Response(
        JSON.stringify({ error: "Database temporarily unavailable" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    throw new Error(`Unexpected fetch call: ${String(input)}`);
  };

  await assert.rejects(
    () =>
      uploadAssetWithPresignedUrl({
        file,
        prepareUrl,
        registerUrl,
        registerBody: ({ key, resolvedType, contentType }) => ({
          key,
          filename: file.name,
          type: resolvedType,
          mimeType: contentType,
          sizeBytes: file.size,
        }),
        fetchImpl: fetchMock,
      }),
    (error: unknown) => {
      assert(error instanceof AssetUploadError);
      assert.equal(error.stage, "register");
      assert.equal(error.message, "Database temporarily unavailable");
      return true;
    }
  );
});

test("getUploadMetadata preserves extension-based MIME inference for dragged files", () => {
  const font = getUploadMetadata(new File(["font"], "cinematic-title.woff2", { type: "" }));
  const image = getUploadMetadata(new File(["image"], "scene.webp", { type: "" }));

  assert.deepEqual(font, {
    type: "font",
    contentType: "font/woff2",
  });
  assert.deepEqual(image, {
    type: "image",
    contentType: "image/webp",
  });
});

// The cover downscale re-encodes through a canvas, which keeps one frame, so an
// animated cover has to be recognised before it gets there.
function riffWebp(chunk: string, flags = 0): Blob {
  const head = new Uint8Array(30);
  head.set([..."RIFF"].map((ch) => ch.charCodeAt(0)), 0);
  head.set([..."WEBP"].map((ch) => ch.charCodeAt(0)), 8);
  head.set([...chunk].map((ch) => ch.charCodeAt(0)), 12);
  const view = new DataView(head.buffer);
  view.setUint32(4, head.length - 8, true);
  view.setUint32(16, 10, true);
  head[20] = flags;
  return new Blob([head], { type: "image/webp" });
}

test("isAnimatedImageFile recognises animated WebP, APNG and GIF", async () => {
  assert.equal(await isAnimatedImageFile(riffWebp("VP8X", 0x02)), true);
  assert.equal(await isAnimatedImageFile(pngFile(true)), true);
  assert.equal(await isAnimatedImageFile(new Blob(["GIF89a"], { type: "image/gif" })), true);
});

test("isAnimatedImageFile leaves still images to the downscale", async () => {
  assert.equal(await isAnimatedImageFile(riffWebp("VP8L")), false);
  assert.equal(await isAnimatedImageFile(riffWebp("VP8X", 0x10)), false);
  assert.equal(await isAnimatedImageFile(pngFile()), false);
  assert.equal(await isAnimatedImageFile(new Blob(["\xff\xd8\xff"], { type: "image/jpeg" })), false);
});
