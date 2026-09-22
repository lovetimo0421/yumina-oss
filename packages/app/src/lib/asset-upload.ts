import { holdReload } from "./reload-safety";
import { feedback } from "./feedback";
import i18n from "./i18n";

export type UploadAssetType = "image" | "audio" | "font" | "txt" | "other";
export type AssetUploadStage = "prepare" | "storage" | "register";

export interface UploadProgress {
  fraction: number;
  loaded: number;
  total: number;
  bytesPerSecond: number;
}

const DEFAULT_REGISTER_TIMEOUT_MS = 20_000;
const MIN_STORAGE_TIMEOUT_MS = 120_000; // 2 minutes base
const TIMEOUT_PER_MB_MS = 10_000; // +10 seconds per MB
const MAX_STORAGE_RETRIES = 1;

const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

const FONT_MIME_ALIASES: Record<string, string> = {
  "application/font-woff": "font/woff",
  "application/font-woff2": "font/woff2",
  "application/x-font-woff": "font/woff",
  "application/x-font-woff2": "font/woff2",
  "application/x-font-ttf": "font/ttf",
  "application/x-font-truetype": "font/ttf",
  "application/x-font-otf": "font/otf",
  "application/vnd.ms-opentype": "font/otf",
};

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

interface PresignedUploadData {
  uploadUrl?: string;
  key?: string;
}

interface UploadRequestContext {
  file: File;
  resolvedType: UploadAssetType;
  contentType: string;
  key: string;
}

export interface PresignedAssetUploadConfig {
  file: File;
  preferredType?: UploadAssetType;
  prepareUrl: string;
  registerUrl: string;
  prepareBody?: Record<string, unknown>;
  registerBody:
    | Record<string, unknown>
    | ((context: UploadRequestContext) => Record<string, unknown>);
  fetchImpl?: typeof fetch;
  prepareCredentials?: RequestCredentials;
  registerCredentials?: RequestCredentials;
  storageTimeoutMs?: number;
  registerTimeoutMs?: number;
  /**
   * When set, a raster image (not GIF/SVG) is downscaled to at most this many
   * pixels on its longest edge and re-encoded as JPEG before upload. Use for
   * cover / banner images shown as cards so a creator's full-size original
   * (we saw 8 MB) isn't served as a "thumbnail". Fails soft to the original.
   */
  resizeImageMaxDimension?: number;
  resizeImageQuality?: number;
  onProgress?: (progress: UploadProgress) => void;
}

export class AssetUploadError extends Error {
  stage: AssetUploadStage;
  status?: number;

  constructor(stage: AssetUploadStage, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options);
    this.name = "AssetUploadError";
    this.stage = stage;
    this.status = options?.status;
  }
}

function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : "";
}

function normalizeMimeType(filename: string, mimeType?: string): string {
  const raw = mimeType?.trim().toLowerCase() ?? "";
  const normalized = FONT_MIME_ALIASES[raw] ?? raw;
  const extensionMimeType = EXTENSION_MIME_TYPES[getExtension(filename)];

  if (!normalized || normalized === "application/octet-stream" || normalized === "binary/octet-stream") {
    return extensionMimeType ?? "application/octet-stream";
  }

  if (normalized === "application/font-sfnt" || normalized === "font/sfnt") {
    return extensionMimeType ?? "font/ttf";
  }

  return normalized;
}

function getStageLabel(stage: AssetUploadStage): string {
  switch (stage) {
    case "prepare":
      return "prepare upload";
    case "storage":
      return "upload file";
    case "register":
      return "register asset";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

function createTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  };
}

async function parseApiResponse<T>(response: Response): Promise<ApiResponse<T> | null> {
  try {
    return (await response.json()) as ApiResponse<T>;
  } catch {
    return null;
  }
}

function getApiErrorMessage<T>(payload: ApiResponse<T> | null, fallback: string): string {
  const message = payload?.error?.trim();
  return message || fallback;
}

export function getAssetUploadErrorMessage(error: unknown): string {
  if (error instanceof AssetUploadError) {
    return error.message;
  }

  return "Upload failed";
}

/** 2 min base + 10s per MB — generous timeout that won't kill slow connections */
function calculateStorageTimeout(fileSize: number): number {
  const fileMB = fileSize / (1024 * 1024);
  return MIN_STORAGE_TIMEOUT_MS + fileMB * TIMEOUT_PER_MB_MS;
}

function isRetryableStorageError(error: unknown): boolean {
  if (error instanceof AssetUploadError) {
    // Don't retry client errors (4xx) — presigned URL expired, bad request, etc.
    if (error.status && error.status >= 400 && error.status < 500) return false;
    return true;
  }
  return true;
}

async function withRetry(
  fn: () => Promise<void>,
  maxRetries: number,
  shouldRetry: (error: unknown) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      if (attempt < maxRetries && shouldRetry(error)) continue;
      throw error;
    }
  }
}

/** XHR-based upload that reports progress with speed — used in browsers when onProgress is provided */
function uploadWithXhr(
  url: string,
  file: File,
  contentType: string,
  timeoutMs: number,
  onProgress: (progress: UploadProgress) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.timeout = timeoutMs;

    let startTime = 0;
    xhr.upload.addEventListener("loadstart", () => {
      startTime = Date.now();
    });

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const elapsed = (Date.now() - startTime) / 1000;
        const bytesPerSecond = elapsed > 0 ? e.loaded / elapsed : 0;
        onProgress({
          fraction: e.loaded / e.total,
          loaded: e.loaded,
          total: e.total,
          bytesPerSecond,
        });
      }
    });

    xhr.addEventListener("load", () => resolve(xhr.status));
    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.addEventListener("timeout", () => {
      reject(new DOMException("Upload timed out", "AbortError"));
    });

    xhr.send(file);
  });
}

async function uploadToStorage(
  url: string,
  file: File,
  contentType: string,
  timeoutMs: number,
  onProgress?: (progress: UploadProgress) => void,
  customFetch?: typeof fetch,
): Promise<void> {
  // Use XHR for upload progress when available and not using a custom fetch (tests)
  if (onProgress && typeof XMLHttpRequest !== "undefined" && !customFetch) {
    try {
      const status = await uploadWithXhr(url, file, contentType, timeoutMs, onProgress);
      if (status < 200 || status >= 300) {
        throw new AssetUploadError("storage", "Upload to storage failed", { status });
      }
      return;
    } catch (error) {
      if (error instanceof AssetUploadError) throw error;
      if (isAbortError(error)) {
        throw new AssetUploadError("storage", "Upload to storage timed out", { cause: error });
      }
      throw new AssetUploadError("storage", "Upload to storage failed", { cause: error });
    }
  }

  // Fallback: fetch-based upload (no progress, used in tests or when onProgress not needed)
  const f = customFetch ?? fetch;
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await f(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: file,
      signal: timeout.signal,
    });

    if (!response.ok) {
      throw new AssetUploadError("storage", "Upload to storage failed", {
        status: response.status,
      });
    }
  } catch (error) {
    if (error instanceof AssetUploadError) throw error;

    if (isAbortError(error)) {
      throw new AssetUploadError("storage", "Upload to storage timed out", { cause: error });
    }

    throw new AssetUploadError("storage", "Upload to storage failed", { cause: error });
  } finally {
    timeout.cleanup();
  }
}

/**
 * Whether an image file is animated: any GIF, a WebP carrying an ANIM chunk, or
 * a PNG with an acTL chunk (APNG) ahead of its first IDAT. Reads the header
 * only. The canvas downscale below keeps one frame, so an animated cover must
 * skip it — a 1.2MB animated WebP cover used to be re-encoded to a still JPEG.
 */
export async function isAnimatedImageFile(file: Blob): Promise<boolean> {
  if (file.type === "image/gif") return true;
  if (file.type !== "image/webp" && file.type !== "image/png" && file.type !== "image/apng") return false;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  } catch {
    return false;
  }
  const ascii = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    // VP8X carries an animation flag (bit 1 of the flags byte); ANIM confirms it
    if (ascii(12, 4) === "VP8X" && (bytes[20]! & 0x02) !== 0) return true;
    return ascii(12, Math.min(bytes.length - 12, 256)).includes("ANIM");
  }
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") {
    const head = ascii(8, bytes.length - 8);
    const actl = head.indexOf("acTL");
    return actl >= 0 && (head.indexOf("IDAT") < 0 || actl < head.indexOf("IDAT"));
  }
  return false;
}

/**
 * Downscale a raster image (not GIF/SVG) to at most `maxDimension` px on its
 * longest edge and re-encode as JPEG, in the browser via canvas. Stops a
 * creator's full-size original (we saw 8 MB) from being stored as a card
 * "thumbnail". Fails SOFT — any non-image, decode failure, missing canvas, or a
 * re-encode that isn't actually smaller returns the ORIGINAL file untouched, so
 * the worst case is exactly today's behavior.
 */
async function downscaleImageFile(file: File, maxDimension: number, quality: number): Promise<File> {
  if (
    typeof document === "undefined" ||
    typeof createImageBitmap === "undefined" ||
    !file.type.startsWith("image/") ||
    file.type === "image/gif" ||
    file.type === "image/svg+xml"
  ) {
    return file;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file; // decode unsupported/failed → upload the original untouched
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxDimension / longest);
    // Already within bounds and not heavy → leave it (preserves small PNGs/alpha).
    if (scale >= 1 && file.size <= 600 * 1024) return file;

    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // White matte: flattening any transparency to JPEG would otherwise go black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!blob || blob.size >= file.size) return file; // no real win → keep original

    const baseName = file.name.replace(/\.[^./\\]+$/, "") || "image";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}

async function uploadAssetWithPresignedUrlUnguarded<T>({
  file: inputFile,
  preferredType,
  prepareUrl,
  registerUrl,
  prepareBody,
  registerBody,
  fetchImpl,
  prepareCredentials = "include",
  registerCredentials = "include",
  storageTimeoutMs,
  registerTimeoutMs = DEFAULT_REGISTER_TIMEOUT_MS,
  resizeImageMaxDimension,
  resizeImageQuality,
  onProgress,
}: PresignedAssetUploadConfig): Promise<T> {
  const f = fetchImpl ?? fetch;
  // An animated image is uploaded as-is (the downscale would keep one frame),
  // and the prepare call says so, so a cover key can be marked for the
  // still-first rendering in <CroppedImage>.
  const animated = await isAnimatedImageFile(inputFile);
  // Opt-in client-side downscale for card/cover/banner images (fails soft to original).
  const file = resizeImageMaxDimension && !animated
    ? await downscaleImageFile(inputFile, resizeImageMaxDimension, resizeImageQuality ?? 0.82)
    : inputFile;
  const { type: resolvedType, contentType } = getUploadMetadata(file, preferredType);

  // Warn (but don't block) on large files
  const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10 MB
  if (file.size > LARGE_FILE_THRESHOLD) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    console.warn(`[Upload] Large file: ${file.name} (${sizeMB}MB) — may cause slow loading for users on mobile`);
    feedback.notice(
      i18n.t("library:upload.largeFile", { defaultValue: "Large file ({{size}} MB) may load slowly", size: sizeMB }),
    );
  }

  // Dynamic timeout: 2 min base + 10s/MB, or explicit override
  const effectiveStorageTimeout = storageTimeoutMs ?? calculateStorageTimeout(file.size);

  // Stage 1: Prepare — get presigned URL
  const prepareResponse = await f(prepareUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: prepareCredentials,
    body: JSON.stringify({
      filename: file.name,
      contentType,
      type: resolvedType,
      ...(animated ? { animated: true } : {}),
      ...prepareBody,
    }),
  });

  const preparePayload = await parseApiResponse<PresignedUploadData>(prepareResponse);

  if (!prepareResponse.ok) {
    throw new AssetUploadError(
      "prepare",
      getApiErrorMessage(preparePayload, "Failed to prepare upload"),
      { status: prepareResponse.status }
    );
  }

  const uploadUrl = preparePayload?.data?.uploadUrl;
  const key = preparePayload?.data?.key;

  if (!uploadUrl || !key) {
    throw new AssetUploadError("prepare", "Failed to prepare upload");
  }

  // Stage 2: Upload to S3 with retry on transient errors
  const customFetch = fetchImpl ? f : undefined;
  await withRetry(
    () => {
      onProgress?.({ fraction: 0, loaded: 0, total: file.size, bytesPerSecond: 0 });
      return uploadToStorage(uploadUrl, file, contentType, effectiveStorageTimeout, onProgress, customFetch);
    },
    MAX_STORAGE_RETRIES,
    isRetryableStorageError,
  );

  // Stage 3: Register asset in DB
  const payload =
    typeof registerBody === "function"
      ? registerBody({ file, resolvedType, contentType, key })
      : registerBody;

  const registerTimeout = createTimeoutSignal(registerTimeoutMs);
  try {
    const registerResponse = await f(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: registerCredentials,
      body: JSON.stringify(payload),
      signal: registerTimeout.signal,
    });

    const registerPayload = await parseApiResponse<T>(registerResponse);

    if (!registerResponse.ok) {
      throw new AssetUploadError(
        "register",
        getApiErrorMessage(registerPayload, "Failed to register asset"),
        { status: registerResponse.status }
      );
    }

    if (registerPayload?.data === undefined) {
      throw new AssetUploadError("register", "Failed to register asset");
    }

    return registerPayload.data;
  } catch (error) {
    if (error instanceof AssetUploadError) throw error;

    if (isAbortError(error)) {
      throw new AssetUploadError("register", "Asset registration timed out", { cause: error });
    }

    throw new AssetUploadError("register", `Failed to ${getStageLabel("register")}`, { cause: error });
  } finally {
    registerTimeout.cleanup();
  }
}

/** Public entry: identical to the inner function, but blocks deploy reloads mid-upload (spec §5). */
export async function uploadAssetWithPresignedUrl<T>(config: PresignedAssetUploadConfig): Promise<T> {
  const release = holdReload("upload");
  try {
    return await uploadAssetWithPresignedUrlUnguarded<T>(config);
  } finally {
    release();
  }
}

export function inferAssetTypeFromFile(file: Pick<File, "name" | "type">): UploadAssetType {
  const mimeType = normalizeMimeType(file.name, file.type);

  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("font/") || mimeType.includes("font")) return "font";
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "txt";

  const extension = getExtension(file.name);
  if (["ttf", "otf", "woff", "woff2"].includes(extension)) return "font";
  if (["txt", "log", "md", "markdown", "csv", "json"].includes(extension)) return "txt";

  return "other";
}

export function getUploadMetadata(
  file: Pick<File, "name" | "type">,
  preferredType?: UploadAssetType
): { type: UploadAssetType; contentType: string } {
  const inferredType = inferAssetTypeFromFile(file);
  const type = preferredType ?? inferredType;
  const contentType = normalizeMimeType(file.name, file.type);

  if (type === "font" && contentType === "application/octet-stream") {
    const extensionMimeType = EXTENSION_MIME_TYPES[getExtension(file.name)];
    return {
      type,
      contentType: extensionMimeType ?? "font/ttf",
    };
  }

  return { type, contentType };
}
