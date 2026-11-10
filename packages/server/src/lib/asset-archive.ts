import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { extract } from "tar-stream";
import { ASSET_ARCHIVE_LIMITS, isAssetArchiveFilename } from "@yumina/shared";
import { normalizeAssetMimeType } from "./asset-mime.js";

export class AssetImportError extends Error {
  constructor(public code: string, public status: 400 | 404 | 409 | 413 | 429 | 503 = 400) {
    super(code);
  }
}

export interface ArchiveFile {
  path: string;
  size: number;
  mimeType: string;
  type: "image" | "video" | "audio" | "font" | "txt" | "other";
}

const BLOCKED_EXTENSIONS = /\.(html?|xhtml|svg|xml|js|mjs|cjs|jsx|tsx)$/i;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function normalizeArchivePath(name: string): string {
  if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f]/.test(name) || /^[A-Za-z]:|^\//.test(name)) {
    throw new AssetImportError("ARCHIVE_UNSAFE_PATH");
  }
  const parts = name.normalize("NFC").split("/").filter(part => part !== "." && part !== "");
  if (!parts.length || parts.length > ASSET_ARCHIVE_LIMITS.depth || parts.some(part => part === ".." || part.length > 200)) {
    throw new AssetImportError("ARCHIVE_UNSAFE_PATH");
  }
  return parts.join("/");
}

function fileMetadata(path: string, size: number): ArchiveFile | null {
  if (path.split("/").some(part => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._")) || BLOCKED_EXTENSIONS.test(path)) return null;
  const mimeType = normalizeAssetMimeType(path);
  const type = mimeType.startsWith("image/") ? "image"
    : mimeType.startsWith("video/") ? "video"
    : mimeType.startsWith("audio/") ? "audio"
    : mimeType.startsWith("font/") ? "font"
    : mimeType.startsWith("text/") || mimeType === "application/json" ? "txt" : "other";
  return { path, size, mimeType, type };
}

/** Validates the complete archive, visiting one bounded file at a time; never writes archive paths to disk. */
export async function visitAssetArchive(
  bytes: Buffer,
  filename: string,
  visitor: (file: ArchiveFile, bytes: Buffer) => Promise<void>,
  signal?: AbortSignal,
): Promise<{ files: number; expandedBytes: number; ignored: number }> {
  if (!isAssetArchiveFilename(filename)) throw new AssetImportError("ARCHIVE_UNSUPPORTED");
  if (!bytes.length || bytes.length > ASSET_ARCHIVE_LIMITS.compressedBytes) throw new AssetImportError("ARCHIVE_TOO_LARGE", 413);
  const seen = new Set<string>();
  let entries = 0;
  let expandedBytes = 0;
  let files = 0;
  let ignored = 0;
  const consume = async (name: string, size: number, stream: AsyncIterable<unknown>, kind: "file" | "directory", expectedCrc?: number) => {
    signal?.throwIfAborted();
    if (++entries > ASSET_ARCHIVE_LIMITS.files * 2) throw new AssetImportError("ARCHIVE_TOO_MANY_FILES", 413);
    if (!Number.isSafeInteger(size) || size < 0 || size > ASSET_ARCHIVE_LIMITS.fileBytes) throw new AssetImportError("ARCHIVE_FILE_TOO_LARGE", 413);
    expandedBytes += size;
    if (expandedBytes > ASSET_ARCHIVE_LIMITS.expandedBytes) throw new AssetImportError("ARCHIVE_TOO_LARGE", 413);
    // A tar root-directory marker is valid, but it never creates a folder.
    const rootDirectory = kind === "directory" && /^\.\/?$/.test(name);
    const path = rootDirectory ? "" : normalizeArchivePath(name);
    if (kind === "file" && seen.has(path)) throw new AssetImportError("ARCHIVE_DUPLICATE_PATH");
    if (kind === "file") seen.add(path);
    const metadata = kind === "file" ? fileMetadata(path, size) : null;
    let actual = 0;
    let crc = 0xffffffff;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw new AssetImportError("ARCHIVE_INVALID");
      actual += chunk.length;
      if (actual > size || actual > ASSET_ARCHIVE_LIMITS.fileBytes) throw new AssetImportError("ARCHIVE_INVALID");
      if (expectedCrc !== undefined) for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
      if (metadata) chunks.push(Buffer.from(chunk));
    }
    if (actual !== size || (expectedCrc !== undefined && ((crc ^ 0xffffffff) >>> 0) !== expectedCrc)) throw new AssetImportError("ARCHIVE_INVALID");
    if (kind === "directory") return;
    if (!metadata) { ignored++; return; }
    if (++files > ASSET_ARCHIVE_LIMITS.files) throw new AssetImportError("ARCHIVE_TOO_MANY_FILES", 413);
    await visitor(metadata, Buffer.concat(chunks, actual));
  };

  try {
    if (/\.zip$/i.test(filename)) {
      const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, archive) => error ? reject(error) : resolve(archive!)));
      await new Promise<void>((resolve, reject) => {
        const fail = (error: unknown) => { zip.close(); reject(error); };
        const abort = () => fail(signal?.reason ?? new Error("Aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        zip.once("end", () => { signal?.removeEventListener("abort", abort); resolve(); });
        zip.once("error", error => { signal?.removeEventListener("abort", abort); fail(error); });
        zip.on("entry", (entry: Entry) => {
          void (async () => {
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (entry.generalPurposeBitFlag & 1) throw new AssetImportError("ARCHIVE_ENCRYPTED");
            if (mode && mode !== 0x8000 && mode !== 0x4000) throw new AssetImportError("ARCHIVE_LINK_NOT_ALLOWED");
            // Check size before asking the inflater to produce any bytes.
            if (entry.uncompressedSize > ASSET_ARCHIVE_LIMITS.fileBytes) throw new AssetImportError("ARCHIVE_FILE_TOO_LARGE", 413);
            const stream = await new Promise<Readable>((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value!)));
            try { await consume(entry.fileName, entry.uncompressedSize, stream, entry.fileName.endsWith("/") ? "directory" : "file", entry.crc32); }
            finally { stream.destroy(); }
            zip.readEntry();
          })().catch(error => { signal?.removeEventListener("abort", abort); fail(error); });
        });
        if (signal?.aborted) abort(); else zip.readEntry();
      });
    } else {
      const tar = extract();
      let decompressed = 0;
      const cap = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        decompressed += chunk.length;
        callback(decompressed > ASSET_ARCHIVE_LIMITS.expandedBytes + ASSET_ARCHIVE_LIMITS.files * 4096 ? new AssetImportError("ARCHIVE_TOO_LARGE", 413) : null, chunk);
      } });
      tar.on("entry", (header, stream, next) => {
        // A rejected header has no async iterator yet. Consume the source's
        // error event as well as the extract pipeline's so malformed input
        // cannot become an unhandled stream error after the request ends.
        stream.on("error", () => {});
        void (async () => {
          if (header.type !== "file" && header.type !== "directory") throw new AssetImportError("ARCHIVE_LINK_NOT_ALLOWED");
          await consume(header.name, header.size ?? 0, stream, header.type);
          next();
        })().catch(error => { stream.destroy(error); tar.destroy(error); });
      });
      if (/\.(tar\.gz|tgz)$/i.test(filename)) await pipeline(Readable.from([bytes]), createGunzip(), cap, tar, { signal });
      else await pipeline(Readable.from([bytes]), cap, tar, { signal });
    }
  } catch (error) {
    if (error instanceof AssetImportError || signal?.aborted) throw error;
    throw new AssetImportError("ARCHIVE_INVALID");
  }
  if (!files) throw new AssetImportError("ARCHIVE_EMPTY");
  return { files, expandedBytes, ignored };
}
