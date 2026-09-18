/**
 * Asset storage facade.
 *
 * Historically a thin AWS SDK wrapper; now it fronts two backends behind the
 * same export names so the 13 consumers never had to change:
 *
 *   "s3"    — the three AWS_* vars are set (yumina.io, any S3-compatible bucket)
 *   "local" — no bucket, but this is the local edition or a dev run:
 *             `LocalDiskStorage` under STORAGE_DIR, uploads via /storage/upload
 *   "none"  — hosted production without a bucket: every route 503s as before
 *
 * The S3 client is constructed lazily, so importing this module without AWS
 * credentials never touches the SDK.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import { env, IS_DEV, IS_LOCAL_EDITION, PUBLIC_ORIGIN, STORAGE_DIR } from "./env.js";
import { LocalDiskStorage } from "./storage/local-disk.js";

export type StorageKind = "s3" | "local" | "none";

/** Which backend answers storage calls right now. */
export function storageKind(): StorageKind {
  if (env.AWS_S3_BUCKET_NAME && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return "s3";
  if (IS_LOCAL_EDITION || IS_DEV) return "local";
  return "none";
}

/**
 * True when SOME storage backend is configured — S3 or local disk. The name
 * predates the local backend and is kept because every asset route gates on
 * it; read it as "asset storage is available".
 */
export function isS3Configured(): boolean {
  return storageKind() !== "none";
}

// ---------------------------------------------------------------------------
// Local-disk backend (lazy singleton bound to env)
// ---------------------------------------------------------------------------

let _local: LocalDiskStorage | null = null;

/** The env-bound on-disk backend. Only meaningful when `storageKind() === "local"`. */
export function getLocalDiskStorage(): LocalDiskStorage {
  if (!_local) {
    _local = new LocalDiskStorage({
      root: STORAGE_DIR,
      publicOrigin: PUBLIC_ORIGIN,
      secret: env.BETTER_AUTH_SECRET,
    });
  }
  return _local;
}

/** Verify a `/storage/upload?token=` token minted by `generateUploadUrl` in local mode. */
export function verifyUploadToken(token: string): { key: string; contentType: string } | null {
  return getLocalDiskStorage().verifyUploadToken(token);
}

function useLocal(): boolean {
  return storageKind() === "local";
}

// ---------------------------------------------------------------------------
// S3 backend (lazy client)
// ---------------------------------------------------------------------------

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: env.AWS_DEFAULT_REGION,
      endpoint: env.AWS_ENDPOINT_URL,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Public API — every function dispatches on storageKind()
// ---------------------------------------------------------------------------

/**
 * URL for client-side direct upload (1 hour expiry). S3: presigned PUT.
 * Local: `${PUBLIC_ORIGIN}/storage/upload?token=…`, authorized by the token.
 */
export async function generateUploadUrl(
  key: string,
  contentType: string
): Promise<string> {
  if (useLocal()) return getLocalDiskStorage().generateUploadUrl(key, contentType);
  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(getClient(), command, { expiresIn: 3600 });
}

/** Inspect an object without exposing it through the public CDN proxy. */
export async function headObject(key: string): Promise<{
  contentType: string;
  contentLength: number;
  etag: string | null;
}> {
  if (useLocal()) return getLocalDiskStorage().headObject(key);
  const response = await getClient().send(new HeadObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: key,
  }));
  return {
    contentType: response.ContentType ?? "application/octet-stream",
    contentLength: response.ContentLength ?? 0,
    etag: response.ETag?.replace(/^\"|\"$/g, "") ?? null,
  };
}

/**
 * Fetch an object — returns the readable stream, content-type, and content-length.
 * `body` is an SDK stream for S3 or a Node `Readable` for local disk; both
 * consumers (`cdn.ts`, event-proof reads) already branch on `instanceof Readable`.
 */
export async function getObject(key: string, opts?: { range?: string }): Promise<{
  body: GetObjectCommandOutput["Body"] | Readable;
  contentType: string;
  contentLength: number | undefined;
  contentRange: string | null;
  etag: string | null;
}> {
  if (useLocal()) return getLocalDiskStorage().getObject(key, opts);
  const command = new GetObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: key,
    // Forwarded verbatim from the client's Range header (e.g. "bytes=0-")
    // so audio/video seeks fetch only the requested slice. S3 answers ranged
    // GETs with 206 + ContentRange; un-ranged behavior is unchanged.
    ...(opts?.range ? { Range: opts.range } : {}),
  });
  const response = await getClient().send(command);
  return {
    body: response.Body,
    contentType: response.ContentType ?? "application/octet-stream",
    contentLength: response.ContentLength,
    contentRange: response.ContentRange ?? null,
    etag: response.ETag ?? null,
  };
}

/**
 * Fetch an object fully into a Buffer — for server-side processing (image
 * resize). Uses the AWS SDK v3 stream mixin so it works regardless of the
 * underlying stream flavor.
 */
export async function getObjectBuffer(
  key: string,
  options?: { signal?: AbortSignal; maxBytes?: number },
): Promise<{ buffer: Buffer; contentType: string }> {
  if (useLocal()) return getLocalDiskStorage().getObjectBuffer(key, options);
  const command = new GetObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: key,
  });
  const response = await getClient().send(command, { abortSignal: options?.signal });
  if (!response.Body) throw new Error("Empty S3 object body");
  const reader = response.Body.transformToWebStream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (options?.maxBytes && size > options.maxBytes) throw new Error("S3 object too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks, size);
  return {
    buffer: Buffer.from(bytes),
    contentType: response.ContentType ?? "application/octet-stream",
  };
}

/** Overwrite/create an object — server-side writes (e.g. resized images). */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  if (useLocal()) return getLocalDiskStorage().putObject(key, body, contentType, opts);
  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  });
  await getClient().send(command, { abortSignal: opts?.signal });
}

/** Copy an object server-side to a key that was never exposed by a presigned PUT. */
export async function copyObject(sourceKey: string, destinationKey: string): Promise<void> {
  if (useLocal()) return getLocalDiskStorage().copyObject(sourceKey, destinationKey);
  const encodedSource = `${env.AWS_S3_BUCKET_NAME}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`;
  await getClient().send(new CopyObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    CopySource: encodedSource,
    Key: destinationKey,
  }));
}

/** Delete an object (missing objects are not an error on either backend). */
export async function deleteObject(key: string): Promise<void> {
  if (useLocal()) return getLocalDiskStorage().deleteObject(key);
  const command = new DeleteObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: key,
  });
  await getClient().send(command);
}

/** Delete every object below a key prefix, in S3's native 1,000-key batches. */
export async function deletePrefix(prefix: string): Promise<number> {
  if (useLocal()) return getLocalDiskStorage().deletePrefix(prefix);
  let deleted = 0;

  // S3-compatible stores are strongly consistent for deletes. Re-listing the
  // first page avoids continuation-token edge cases while keys disappear.
  for (;;) {
    const page = await getClient().send(new ListObjectsV2Command({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Prefix: prefix,
      MaxKeys: 1000,
    }));
    const objects = (page.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => !!key);

    if (objects.length === 0) return deleted;

    const result = await getClient().send(new DeleteObjectsCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Delete: {
        Objects: objects.map((Key) => ({ Key })),
        Quiet: true,
      },
    }));

    if (result.Errors?.length) {
      throw new Error(`Failed to delete ${result.Errors.length} objects below ${prefix}`);
    }
    deleted += objects.length;
  }
}

/**
 * Time-limited read URL. S3: presigned GET. Local: the permanent `/cdn/key/…`
 * proxy URL (served only for prefixes in cdn.ts ALLOWED_KEY_PREFIXES).
 */
export async function generateDownloadUrl(
  key: string,
  expiresInSeconds = 7200,
): Promise<string> {
  if (useLocal()) return getLocalDiskStorage().generateDownloadUrl(key);
  const command = new GetObjectCommand({
    Bucket: env.AWS_S3_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
}
