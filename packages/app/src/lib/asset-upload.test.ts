import test from "node:test";
import assert from "node:assert/strict";
import {
  AssetUploadError,
  getUploadMetadata,
  isAnimatedImageFile,
  uploadAssetWithPresignedUrl,
} from "./asset-upload";

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
function riffWebp(chunk: string, flags = 0, extra = ""): Blob {
  const head = new Uint8Array(21);
  head.set([..."RIFF"].map((ch) => ch.charCodeAt(0)), 0);
  head.set([..."WEBP"].map((ch) => ch.charCodeAt(0)), 8);
  head.set([...chunk].map((ch) => ch.charCodeAt(0)), 12);
  head[20] = flags;
  return new Blob([head, extra], { type: "image/webp" });
}
function png(chunks: string[]): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunks.join("....")], { type: "image/png" });
}

test("isAnimatedImageFile recognises animated WebP, APNG and GIF", async () => {
  assert.equal(await isAnimatedImageFile(riffWebp("VP8X", 0x02)), true);
  assert.equal(await isAnimatedImageFile(riffWebp("VP8X", 0x10, "....ANIM....ANMF")), true);
  assert.equal(await isAnimatedImageFile(png(["IHDR", "acTL", "IDAT"])), true);
  assert.equal(await isAnimatedImageFile(new Blob(["GIF89a"], { type: "image/gif" })), true);
});

test("isAnimatedImageFile leaves still images to the downscale", async () => {
  assert.equal(await isAnimatedImageFile(riffWebp("VP8L")), false);
  assert.equal(await isAnimatedImageFile(riffWebp("VP8X", 0x10)), false);
  assert.equal(await isAnimatedImageFile(png(["IHDR", "IDAT"])), false);
  assert.equal(await isAnimatedImageFile(new Blob(["\xff\xd8\xff"], { type: "image/jpeg" })), false);
});
