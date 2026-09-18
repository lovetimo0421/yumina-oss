import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  LocalDiskStorage,
  StorageError,
  assertValidKey,
  resolveRange,
  signUploadToken,
  verifyUploadToken,
} from "./local-disk.js";

const SECRET = "test-secret-not-for-production";
const ORIGIN = "http://localhost:5173";

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function status(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

function webStreamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("LocalDiskStorage", () => {
  let root: string;
  let storage: LocalDiskStorage;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "yumina-local-disk-"));
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    storage = new LocalDiskStorage({ root, publicOrigin: ORIGIN, secret: SECRET, maxUploadBytes: 1024 });
  });

  describe("key validation", () => {
    const bad = [
      "",
      "../etc/passwd",
      "worlds/../../etc/passwd",
      "worlds/./x.png",
      "/abs/path.png",
      "C:\\Windows\\x.png",
      "worlds\\x.png",
      "worlds/x\0.png",
      ".meta/x.json",
      "worlds//x.png",
      "worlds/x.png ",
      "worlds/x?.png",
    ];
    for (const key of bad) {
      test(`rejects ${JSON.stringify(key)}`, () => {
        assert.throws(() => assertValidKey(key), (err: unknown) => err instanceof StorageError && status(err) === 400);
        assert.throws(() => storage.resolvePath(key), (err: unknown) => status(err) === 400);
      });
    }

    test("accepts a normal nested key and keeps it inside root", () => {
      const abs = storage.resolvePath("worlds/abc-123/gallery/a_b.png");
      assert.equal(path.relative(root, abs).split(path.sep).join("/"), "worlds/abc-123/gallery/a_b.png");
      const meta = storage.resolveMetaPath("worlds/abc-123/gallery/a_b.png");
      assert.equal(path.relative(root, meta).split(path.sep).join("/"), ".meta/worlds/abc-123/gallery/a_b.png.json");
    });

    test("every operation refuses a traversal key before touching disk", async () => {
      for (const op of [
        () => storage.headObject("../x"),
        () => storage.getObject("../x"),
        () => storage.getObjectBuffer("../x"),
        () => storage.putObject("../x", Buffer.from("a"), "text/plain"),
        () => storage.copyObject("../x", "y"),
        () => storage.deleteObject("../x"),
        () => storage.deletePrefix("../"),
        () => storage.generateUploadUrl("../x", "image/png"),
      ]) {
        await assert.rejects(op, (err: unknown) => status(err) === 400);
      }
    });
  });

  describe("put/get roundtrip", () => {
    test("stores bytes, sidecar content type, size, etag", async () => {
      await storage.putObject("worlds/w1/cover.bin", Buffer.from("hello world"), "text/plain");
      const got = await storage.getObject("worlds/w1/cover.bin");
      assert.equal((await readAll(got.body)).toString(), "hello world");
      assert.equal(got.contentType, "text/plain");
      assert.equal(got.contentLength, 11);
      assert.equal(got.contentRange, null);
      assert.match(got.etag ?? "", /^"[0-9a-f]{32}"$/);

      const sidecar = JSON.parse(fs.readFileSync(path.join(root, ".meta/worlds/w1/cover.bin.json"), "utf8"));
      assert.equal(sidecar.contentType, "text/plain");
      assert.equal(sidecar.size, 11);
      assert.equal(sidecar.etag, got.etag!.replace(/"/g, ""));
      assert.ok(typeof sidecar.createdAt === "string");

      const head = await storage.headObject("worlds/w1/cover.bin");
      assert.deepEqual(head, { contentType: "text/plain", contentLength: 11, etag: sidecar.etag });

      const buf = await storage.getObjectBuffer("worlds/w1/cover.bin");
      assert.equal(buf.buffer.toString(), "hello world");
      assert.equal(buf.contentType, "text/plain");
    });

    test("overwrites atomically and leaves no temp files behind", async () => {
      await storage.putObject("worlds/w1/over.txt", Buffer.from("one"), "text/plain");
      await storage.putObject("worlds/w1/over.txt", Buffer.from("two"), "text/plain");
      assert.equal((await storage.getObjectBuffer("worlds/w1/over.txt")).buffer.toString(), "two");
      const leftovers = fs.readdirSync(path.join(root, "worlds/w1")).filter((n) => n.endsWith(".tmp"));
      assert.deepEqual(leftovers, []);
    });

    test("falls back to an extension mime map when the sidecar is missing", async () => {
      fs.mkdirSync(path.join(root, "users/u1"), { recursive: true });
      fs.writeFileSync(path.join(root, "users/u1/avatar.png"), Buffer.from([1, 2, 3]));
      const head = await storage.headObject("users/u1/avatar.png");
      assert.equal(head.contentType, "image/png");
      assert.equal(head.contentLength, 3);
      assert.match(head.etag ?? "", /^[0-9a-f]+-[0-9a-f]+$/);
      assert.equal((await storage.headObject("users/u1/avatar.png")).contentType, "image/png");
    });

    test("getObjectBuffer honors maxBytes", async () => {
      await storage.putObject("worlds/w1/big.bin", Buffer.alloc(100), "application/octet-stream");
      await assert.rejects(
        () => storage.getObjectBuffer("worlds/w1/big.bin", { maxBytes: 50 }),
        (err: unknown) => status(err) === 413,
      );
    });
  });

  describe("ranges", () => {
    before(async () => {
      await storage.putObject("worlds/r/song.bin", Buffer.from("hello world"), "audio/mpeg");
    });

    test("bytes=2-5", async () => {
      const got = await storage.getObject("worlds/r/song.bin", { range: "bytes=2-5" });
      assert.equal((await readAll(got.body)).toString(), "llo ");
      assert.equal(got.contentLength, 4);
      assert.equal(got.contentRange, "bytes 2-5/11");
      assert.equal(got.contentType, "audio/mpeg");
    });

    test("bytes=6- (open-ended)", async () => {
      const got = await storage.getObject("worlds/r/song.bin", { range: "bytes=6-" });
      assert.equal((await readAll(got.body)).toString(), "world");
      assert.equal(got.contentRange, "bytes 6-10/11");
    });

    test("bytes=-5 (suffix)", async () => {
      const got = await storage.getObject("worlds/r/song.bin", { range: "bytes=-5" });
      assert.equal((await readAll(got.body)).toString(), "world");
      assert.equal(got.contentLength, 5);
      assert.equal(got.contentRange, "bytes 6-10/11");
    });

    test("end past EOF is clamped", async () => {
      const got = await storage.getObject("worlds/r/song.bin", { range: "bytes=8-999" });
      assert.equal((await readAll(got.body)).toString(), "rld");
      assert.equal(got.contentRange, "bytes 8-10/11");
    });

    test("unsatisfiable start throws the 416 shape", async () => {
      await assert.rejects(
        () => storage.getObject("worlds/r/song.bin", { range: "bytes=20-" }),
        (err: unknown) => err instanceof StorageError && status(err) === 416,
      );
      assert.throws(() => resolveRange("bytes=-0", 11), (err: unknown) => status(err) === 416);
    });

    test("malformed or multi-range headers are ignored (full object)", async () => {
      assert.equal(resolveRange("bytes=5-2", 11), null);
      assert.equal(resolveRange("bytes=0-1,3-4", 11), null);
      assert.equal(resolveRange("items=0-1", 11), null);
      const got = await storage.getObject("worlds/r/song.bin", { range: "bytes=5-2" });
      assert.equal(got.contentRange, null);
      assert.equal(got.contentLength, 11);
    });
  });

  describe("missing keys", () => {
    test("getObject / headObject / getObjectBuffer throw the NoSuchKey/404 shape", async () => {
      for (const op of [
        () => storage.getObject("worlds/nope/missing.png"),
        () => storage.headObject("worlds/nope/missing.png"),
        () => storage.getObjectBuffer("worlds/nope/missing.png"),
        () => storage.copyObject("worlds/nope/missing.png", "worlds/nope/copy.png"),
      ]) {
        await assert.rejects(op, (err: unknown) => {
          const e = err as Error;
          return e.name === "NoSuchKey" && status(err) === 404;
        });
      }
    });

    test("a key that names a directory is treated as missing", async () => {
      await storage.putObject("worlds/dir/child.txt", Buffer.from("x"), "text/plain");
      await assert.rejects(() => storage.headObject("worlds/dir"), (err: unknown) => status(err) === 404);
    });

    test("deleteObject on a missing key is a no-op", async () => {
      await storage.deleteObject("worlds/nope/missing.png");
    });
  });

  describe("upload tokens", () => {
    test("generateUploadUrl mints a verifiable token on the public origin", async () => {
      const url = await storage.generateUploadUrl("worlds/w1/gallery/a.png", "image/png");
      assert.ok(url.startsWith(`${ORIGIN}/storage/upload?token=`), url);
      const token = new URL(url).searchParams.get("token")!;
      assert.deepEqual(storage.verifyUploadToken(token), { key: "worlds/w1/gallery/a.png", contentType: "image/png" });
    });

    test("rejects expired tokens", () => {
      const token = signUploadToken({ key: "worlds/x.png", contentType: "image/png", exp: Date.now() - 1 }, SECRET);
      assert.equal(verifyUploadToken(token, SECRET), null);
      const fresh = signUploadToken({ key: "worlds/x.png", contentType: "image/png", exp: 5_000 }, SECRET);
      assert.deepEqual(verifyUploadToken(fresh, SECRET, 4_999), { key: "worlds/x.png", contentType: "image/png" });
      assert.equal(verifyUploadToken(fresh, SECRET, 5_000), null);
    });

    test("rejects tampered payload, tampered signature, wrong secret, garbage", () => {
      const token = signUploadToken({ key: "worlds/x.png", contentType: "image/png", exp: Date.now() + 60_000 }, SECRET);
      const [payload, sig] = token.split(".") as [string, string];

      const forgedPayload = Buffer.from(
        JSON.stringify({ key: "worlds/y.png", contentType: "image/png", exp: Date.now() + 60_000 }),
      ).toString("base64url");
      assert.equal(verifyUploadToken(`${forgedPayload}.${sig}`, SECRET), null);

      const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
      assert.equal(verifyUploadToken(`${payload}.${flipped}`, SECRET), null);
      assert.equal(verifyUploadToken(`${payload}.${sig.slice(0, -2)}`, SECRET), null);
      assert.equal(verifyUploadToken(token, "another-secret"), null);
      assert.equal(verifyUploadToken("", SECRET), null);
      assert.equal(verifyUploadToken("a.b.c", SECRET), null);
      assert.equal(verifyUploadToken(payload, SECRET), null);
    });

    test("rejects a validly-signed token whose key is a traversal", () => {
      const token = signUploadToken({ key: "../escape.png", contentType: "image/png", exp: Date.now() + 60_000 }, SECRET);
      assert.equal(verifyUploadToken(token, SECRET), null);
    });
  });

  describe("writeFromStream", () => {
    test("streams a web ReadableStream to disk and writes the sidecar", async () => {
      const chunks = [Buffer.from("abc"), Buffer.from("def"), Buffer.from("g")];
      const result = await storage.writeFromStream("users/u1/up.bin", "application/octet-stream", webStreamOf(chunks));
      assert.equal(result.size, 7);
      assert.match(result.etag, /^[0-9a-f]{32}$/);
      const got = await storage.getObject("users/u1/up.bin");
      assert.equal((await readAll(got.body)).toString(), "abcdefg");
      assert.equal(got.contentType, "application/octet-stream");
      assert.equal(got.contentLength, 7);
    });

    test("accepts a Node Readable too", async () => {
      await storage.writeFromStream("users/u1/node.txt", "text/plain", Readable.from([Buffer.from("node")]));
      assert.equal((await storage.getObjectBuffer("users/u1/node.txt")).buffer.toString(), "node");
    });

    test("aborts past maxBytes with a 413 and leaves nothing behind", async () => {
      const chunks = Array.from({ length: 5 }, () => new Uint8Array(4).fill(1)); // 20 bytes
      await assert.rejects(
        () => storage.writeFromStream("users/u1/toobig.bin", "application/octet-stream", webStreamOf(chunks), 10),
        (err: unknown) => err instanceof StorageError && status(err) === 413,
      );
      assert.equal(fs.existsSync(path.join(root, "users/u1/toobig.bin")), false);
      assert.equal(fs.existsSync(path.join(root, ".meta/users/u1/toobig.bin.json")), false);
      const leftovers = fs.readdirSync(path.join(root, "users/u1")).filter((n) => n.endsWith(".tmp"));
      assert.deepEqual(leftovers, []);
    });

    test("uses the instance default ceiling when none is passed", async () => {
      const chunks = [new Uint8Array(1025)];
      await assert.rejects(
        () => storage.writeFromStream("users/u1/default-cap.bin", "application/octet-stream", webStreamOf(chunks)),
        (err: unknown) => status(err) === 413,
      );
    });
  });

  describe("copy / delete / deletePrefix", () => {
    test("copyObject duplicates bytes and metadata", async () => {
      await storage.putObject("event-proofs/pending/e1/a.png", Buffer.from("png!"), "image/png");
      await storage.copyObject("event-proofs/pending/e1/a.png", "event-proofs/sealed/e1/a.png");
      const head = await storage.headObject("event-proofs/sealed/e1/a.png");
      assert.equal(head.contentType, "image/png");
      assert.equal(head.contentLength, 4);
      assert.equal((await storage.getObjectBuffer("event-proofs/sealed/e1/a.png")).buffer.toString(), "png!");
    });

    test("deleteObject removes bytes, sidecar, and empty parents", async () => {
      await storage.putObject("dm/c1/m1/file.txt", Buffer.from("x"), "text/plain");
      await storage.deleteObject("dm/c1/m1/file.txt");
      assert.equal(fs.existsSync(path.join(root, "dm/c1/m1/file.txt")), false);
      assert.equal(fs.existsSync(path.join(root, ".meta/dm/c1/m1/file.txt.json")), false);
      assert.equal(fs.existsSync(path.join(root, "dm")), false);
      assert.equal(fs.existsSync(path.join(root, ".meta/dm")), false);
      assert.ok(fs.existsSync(root));
    });

    test("deletePrefix uses string-prefix semantics and returns the count", async () => {
      await storage.putObject("worlds/p/x/a.png", Buffer.from("a"), "image/png");
      await storage.putObject("worlds/p/x/deep/b.png", Buffer.from("b"), "image/png");
      await storage.putObject("worlds/p/x/c.mp3", Buffer.from("c"), "audio/mpeg");
      await storage.putObject("worlds/p/xy.txt", Buffer.from("d"), "text/plain");
      await storage.putObject("worlds/p/other/keep.png", Buffer.from("k"), "image/png");

      const deleted = await storage.deletePrefix("worlds/p/x");
      assert.equal(deleted, 4);
      assert.equal(fs.existsSync(path.join(root, "worlds/p/x")), false);
      assert.equal(fs.existsSync(path.join(root, "worlds/p/xy.txt")), false);
      assert.equal(fs.existsSync(path.join(root, ".meta/worlds/p/x")), false);
      assert.equal(fs.existsSync(path.join(root, ".meta/worlds/p/xy.txt.json")), false);
      assert.equal((await storage.headObject("worlds/p/other/keep.png")).contentType, "image/png");

      assert.equal(await storage.deletePrefix("worlds/p/"), 1);
      assert.equal(await storage.deletePrefix("worlds/p/"), 0);
      assert.equal(fs.existsSync(path.join(root, "worlds/p")), false);
    });

    test("deletePrefix refuses an empty or traversal prefix", async () => {
      await assert.rejects(() => storage.deletePrefix(""), (err: unknown) => status(err) === 400);
      await assert.rejects(() => storage.deletePrefix("worlds/../"), (err: unknown) => status(err) === 400);
    });
  });
});
