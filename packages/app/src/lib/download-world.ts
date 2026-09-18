import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import type { LanguageVariant } from "@/lib/languages";
import {
  isPng,
  writePngTextChunk,
  utf8ToBase64,
  YUMINA_KEYWORD,
} from "./png-metadata";

const apiBase = import.meta.env.VITE_API_URL || "";

// No React context here (this is a plain lib module), so resolve copy via
// i18n directly rather than useTranslation. toasts.json/common.json are
// frozen — new keys live under the `library` namespace instead.
const dtr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

const downloadLabels = () => ({
  pending: dtr("library:download.pending", "Preparing download"),
  done: dtr("library:download.done", "Download ready"),
  failed: dtr("library:download.failed", "Download failed"),
});

interface WorldDownloadPayload {
  schema: unknown;
  name?: string;
  thumbnailUrl?: string | null;
}

async function fetchWorldPayload(worldId: string): Promise<WorldDownloadPayload | null> {
  try {
    const res = await fetch(`${apiBase}/api/worlds/${worldId}`, { credentials: "include" });
    if (!res.ok) return null;
    const { data } = await res.json();
    return {
      schema: data?.schema ?? {},
      name: data?.name,
      thumbnailUrl: data?.thumbnailUrl ?? null,
    };
  } catch {
    return null;
  }
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Convert any image bytes (PNG/JPEG/WEBP) to PNG bytes via canvas. */
async function reencodeImageToPng(bytes: Uint8Array, mimeHint?: string): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer so Blob's BufferSource type accepts it.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mimeHint || "image/*" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to decode cover image"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(img, 0, 0);
    const pngBlob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
    );
    return new Uint8Array(await pngBlob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Render a simple branded placeholder PNG for worlds without a cover. */
async function makePlaceholderCoverPng(name: string): Promise<Uint8Array> {
  const W = 512;
  const H = 768;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#1c1c1f");
  grad.addColorStop(1, "#0c0c0e");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(32, H - 96, W - 64, 1);

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "500 14px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("Yumina", 32, H - 60);

  ctx.fillStyle = "#f5e9d0";
  ctx.font = "600 32px ui-serif, Georgia, serif";
  const truncated = name.length > 24 ? name.slice(0, 23) + "…" : name;
  ctx.fillText(truncated, 32, H / 2);

  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

async function fetchCoverAsPng(thumbnailUrl: string | null | undefined, fallbackName: string): Promise<Uint8Array> {
  if (thumbnailUrl) {
    try {
      const res = await fetch(thumbnailUrl, { mode: "cors" });
      if (res.ok) {
        const buffer = new Uint8Array(await res.arrayBuffer());
        if (isPng(buffer)) return buffer;
        return await reencodeImageToPng(buffer, res.headers.get("content-type") ?? undefined);
      }
    } catch {
      // fall through to placeholder
    }
  }
  return await makePlaceholderCoverPng(fallbackName);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "world";
}

/** Download a world's schema as a JSON file (no cover). */
export async function downloadWorldJSON(worldId: string, filename?: string): Promise<void> {
  const run = async () => {
    const payload = await fetchWorldPayload(worldId);
    if (!payload) throw new Error("Failed to download world payload");
    const name = sanitizeFilename(filename || payload.name || "world");
    const blob = new Blob([JSON.stringify(payload.schema, null, 2)], { type: "application/json" });
    triggerDownload(blob, `${name}.json`);
  };
  try {
    await feedback.progress(run(), downloadLabels());
  } catch {
    // feedback.progress already showed the failure pill; swallow so callers
    // that don't wrap this in their own try/catch don't blow up.
  }
}

/**
 * Download a world as a PNG character card: cover image + Yumina world JSON
 * embedded as a base64 tEXt chunk under the `yumina` keyword. Falls back to
 * a generated placeholder image if the world has no cover or the cover fails
 * to load. The resulting PNG can be re-imported via the same parseImportedFile.
 */
export async function downloadWorldPNG(worldId: string, filename?: string): Promise<void> {
  const run = async () => {
    const payload = await fetchWorldPayload(worldId);
    if (!payload) throw new Error("Failed to download world payload");
    const name = sanitizeFilename(filename || payload.name || "world");
    const coverPng = await fetchCoverAsPng(payload.thumbnailUrl, payload.name || name);
    const json = JSON.stringify(payload.schema);
    const withMeta = writePngTextChunk(coverPng, YUMINA_KEYWORD, utf8ToBase64(json));
    // Copy through a fresh ArrayBuffer so the Blob constructor's BufferSource
    // type accepts it (Uint8Array<ArrayBufferLike> isn't assignable as-is).
    const bytes = new Uint8Array(withMeta.byteLength);
    bytes.set(withMeta);
    triggerDownload(new Blob([bytes.buffer], { type: "image/png" }), `${name}.png`);
  };
  try {
    await feedback.progress(run(), downloadLabels());
  } catch (err) {
    console.error("PNG export failed:", err);
  }
}

/** Fetch language variants for a world (for download picker) */
export async function fetchVariantsForDownload(worldId: string): Promise<LanguageVariant[]> {
  try {
    const res = await fetch(`${apiBase}/api/worlds/${worldId}/language-variants`, {
      credentials: "include",
    });
    if (!res.ok) return [];
    const { data } = await res.json();
    return data ?? [];
  } catch {
    return [];
  }
}
