/**
 * What the card AI review reads besides the cover: the card's other pictures
 * (as grids) and its whole text for explicit words. The models only see a text
 * sample and a few dozen pictures, so whatever they could not see is counted,
 * and a Limited card with unseen pictures goes to a person.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { assets as worldAssets, userAssets } from "../db/schema.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { getObjectBuffer } from "./s3.js";
import { isPublicCdnKey } from "./cdn-key-policy.js";
import { scanWorldForAssets } from "./scan-world-assets.js";
import { imagesToReviewGrids } from "./world-ai-review-image.js";
export { explicitWordInCard } from "./world-ai-review-core.js";

/** The most pictures the models are shown per card (5 grids of 4×4). */
export const MAX_INNER_IMAGES = 80;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "yumina.io" || host === "www.yumina.io" || host === new URL(PUBLIC_ORIGIN).hostname;
  } catch { return false; }
}

/** A stored picture reference as its S3 key: S3 key, bare asset id or @asset:id. */
export async function coverKey(ref: string, ownerId: string): Promise<string> {
  const asset = /^@asset:(.+)$/.exec(ref)?.[1] ?? (UUID.test(ref) ? ref : null);
  if (!asset) return ref;
  const [row] = await db.select({ url: userAssets.url }).from(userAssets)
    .where(and(eq(userAssets.id, asset), eq(userAssets.userId, ownerId))).limit(1);
  if (!row?.url) throw new Error("asset not found");
  return row.url;
}

/** One picture's bytes, or why there is none: "skip" for a file that isn't a
 *  picture (music, a font), "unseen" for one the models can't judge (a video). */
type Loaded = { buffer: Buffer } | "skip" | "unseen";
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|aac|flac|opus)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i;

function byType(contentType: string, buffer: Buffer): Loaded {
  if (/^audio\//i.test(contentType) || /^font\//i.test(contentType)) return "skip";
  if (/^video\//i.test(contentType)) return "unseen";
  if (buffer.length > MAX_IMAGE_BYTES) return "unseen";
  return { buffer };
}

/** Bytes of one picture the card uses: a storage key, or our own CDN URL.
 *  An outside address is never fetched by the server. */
async function loadPicture(ref: string): Promise<Loaded> {
  if (AUDIO_EXT.test(ref)) return "skip";
  if (VIDEO_EXT.test(ref)) return "unseen";
  if (/^https?:\/\//i.test(ref)) {
    if (!ownHost(ref)) return "unseen";
    const res = await fetch(ref, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!res.ok) throw new Error(`picture ${res.status}`);
    return byType(res.headers.get("content-type") ?? "", Buffer.from(await res.arrayBuffer()));
  }
  // Same rule as the public CDN: the review reads only what anyone could open
  // there, never another account's private file.
  if (ref.includes("..") || !isPublicCdnKey(ref)) return "unseen";
  const { buffer, contentType } = await getObjectBuffer(ref, { maxBytes: MAX_IMAGE_BYTES });
  return byType(contentType, buffer);
}

/** The asset id in "@asset:id", a bare id, or our "/cdn/<id>" URL; the storage
 *  key in our "/cdn/key/<base64url>" URL. */
function parseRef(ref: string): { assetId?: string; key?: string } {
  const assetId = /^@asset:(.+)$/.exec(ref)?.[1] ?? (UUID.test(ref) ? ref : null)
    ?? /\/cdn\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i.exec(ref)?.[1];
  if (assetId) return { assetId };
  const encoded = /\/cdn\/key\/([A-Za-z0-9_-]+)/.exec(ref)?.[1];
  if (encoded) return { key: Buffer.from(encoded, "base64url").toString("utf-8") };
  return {};
}

/** Every picture reference in a card (gallery and schema), as the review finds them. */
function pictureRefs(schemaValue: unknown, gallery: string[], skip: Set<string>) {
  const schema = schemaValue && typeof schemaValue === "object" ? schemaValue as Record<string, unknown> : {};
  const refs = new Set<string>();
  const external = new Set<string>();
  const add = (ref: string | null | undefined) => {
    if (!ref || skip.has(ref)) return;
    if (/^https?:\/\//i.test(ref) && !ownHost(ref)) { external.add(ref); return; }
    refs.add(ref);
  };
  for (const a of scanWorldForAssets({ galleryImages: gallery, schema })) {
    if (a.source === "thumbnail" || a.source === "data_uri") continue;
    add(a.source === "gallery" || a.source === "asset_ref" ? a.raw : a.resolvedUrl ?? a.raw);
  }
  const text = JSON.stringify(schema);
  const scan = text.length < 20_000_000 ? text : "";
  // What the scanner misses: our CDN URLs without an extension and bare storage keys.
  for (const m of scan.matchAll(/https?:\/\/(?:www\.)?yumina\.io\/cdn\/[^\s"'<>()\\]+/gi)) add(m[0]);
  for (const m of scan.matchAll(/(?<=["'(\s])(?:users|worlds)\/[^\s"'<>()\\]+\.(?:png|jpe?g|webp|gif|avif)(?=["')\s])/gi)) add(m[0]);
  // Inline data images: the scanner only keeps a truncated token, so read them here.
  const inline: string[] = [];
  for (const m of scan.matchAll(/data:image\/[a-z0-9+.-]+;base64,([A-Za-z0-9+/=]{50,})/gi)) inline.push(m[1]!);
  const unreadable = Math.max(0, (scan.match(/data:image\//gi) ?? []).length - inline.length);
  return { refs, external, inline, unreadable };
}

/**
 * The card's other pictures, cover(s) excluded, shown to the models as grids:
 * the gallery, @asset references, our own CDN URLs and storage keys (with or
 * without an extension), and inline data images. Music and fonts are skipped.
 * Anything past the cap, on an outside site, a video, in a form we can't read
 * (a non-base64 data image), or failing to load or decode counts as unseen.
 * With `known` (the live card, for an update judged on its changes), only
 * pictures the live card does not already have are collected.
 */
export async function collectInnerImages(args: {
  schema: unknown; gallery: string[]; coverRef: string | null; ownerId: string; excludeRefs?: string[];
  known?: { schema: unknown; gallery: string[] };
}): Promise<{ grids: Buffer[]; unseen: number; seen: number }> {
  const skip = new Set([args.coverRef, ...(args.excludeRefs ?? [])].filter((r): r is string => !!r));
  const found = pictureRefs(args.schema, args.gallery, skip);
  if (args.known) {
    const old = pictureRefs(args.known.schema, args.known.gallery, new Set());
    for (const r of old.refs) found.refs.delete(r);
    for (const r of old.external) found.external.delete(r);
    const oldInline = new Set(old.inline);
    found.inline = found.inline.filter((b) => !oldInline.has(b));
    found.unreadable = Math.max(0, found.unreadable - old.unreadable);
  }
  const refs = found.refs;
  let unseen = found.external.size + found.unreadable;
  const inline = found.inline.map((b) => Buffer.from(b, "base64"));

  // Asset references → their storage key and kind, in one query per 500.
  const parsed = [...refs].map((ref) => ({ ref, ...parseRef(ref) }));
  const assetIds = [...new Set(parsed.flatMap((p) => (p.assetId ? [p.assetId] : [])))];
  const assets = new Map<string, { type: string; url: string }>();
  // Both places the CDN serves an asset id from: card assets, then library assets.
  for (let i = 0; i < assetIds.length; i += 500) {
    const chunk = assetIds.slice(i, i + 500);
    const [worldRows, libraryRows] = await Promise.all([
      db.select({ id: worldAssets.id, type: worldAssets.type, url: worldAssets.url }).from(worldAssets).where(inArray(worldAssets.id, chunk)),
      db.select({ id: userAssets.id, type: userAssets.type, url: userAssets.url }).from(userAssets).where(inArray(userAssets.id, chunk)),
    ]);
    for (const r of [...libraryRows, ...worldRows]) assets.set(r.id, { type: r.type, url: r.url });
  }
  const keys: string[] = [];
  for (const p of parsed) {
    if (p.assetId) {
      const a = assets.get(p.assetId);
      if (!a) unseen++;
      else if (a.type === "image") keys.push(a.url);
      else if (a.type === "video") unseen++;
      // Audio, fonts, text: not pictures, unless the file name says it is one
      // (the declared type alone does not clear a picture).
      else if (/\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?|$)/i.test(a.url)) keys.push(a.url);
    } else keys.push(p.key ?? p.ref);
  }

  const buffers: Buffer[] = inline.slice(0, MAX_INNER_IMAGES);
  unseen += Math.max(0, inline.length - MAX_INNER_IMAGES);
  let queue = [...new Set(keys)];
  // Music and fonts free up room, so keep loading until the cap is reached.
  while (queue.length > 0 && buffers.length < MAX_INNER_IMAGES) {
    const batch = queue.slice(0, Math.min(6, MAX_INNER_IMAGES - buffers.length));
    queue = queue.slice(batch.length);
    const loaded = await Promise.all(batch.map((ref) => loadPicture(ref).catch((): Loaded => "unseen")));
    for (const l of loaded) {
      if (l === "skip") continue;
      if (l === "unseen") unseen++;
      else buffers.push(l.buffer);
    }
  }
  // Whatever is left past the cap is unseen, except what is plainly music.
  unseen += queue.filter((ref) => !AUDIO_EXT.test(ref)).length;
  if (buffers.length === 0) return { grids: [], unseen, seen: 0 };
  const { grids, failed } = await imagesToReviewGrids(buffers);
  return { grids, unseen: unseen + failed, seen: buffers.length - failed };
}
