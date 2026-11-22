// The Studio assistant looking at the creator's own pictures.
//
// `@asset:<id>` was built (2026-03, 8f102fb3b) as a reference the card resolves
// at render time; in the assistant's chat it stayed plain text, so a creator who
// pointed at a background ("does @asset:… match the UI?") got "I can't see
// images" (Discord, 2026-11-12). The creator's attached pictures already reach
// the model as image parts; a reference to one of their own files now does too,
// and view_asset lets the assistant look at one when it decides to.
//
// Only files this creator owns are ever shown: their library (user_assets) and
// this card's own uploads (assets). The address handed to the model is built
// from the stored key, never from text in the message, so nothing here can be
// pointed at an outside URL.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { assets, userAssets } from "../../db/schema.js";
import { isPublicCdnKey } from "../cdn-key-policy.js";
import { PUBLIC_ORIGIN } from "../env.js";
import { getCatalogImageSupport } from "../llm/model-catalog.js";
import type { ChatMessage, ContentPart } from "../llm/types.js";

/** Pictures in one message, attachments included: the composer's own cap. */
export const MAX_MESSAGE_IMAGES = 5;
/** The Studio chat's attachment size cap (routes/studio.ts upload-url). */
export const MAX_ASSET_IMAGE_BYTES = 10 * 1024 * 1024;
/** Pictures one view_asset call may show. */
export const MAX_VIEW_PER_CALL = 4;
/** Pictures view_asset may add over one run: each stays in every later step's input. */
export const MAX_VIEWS_PER_RUN = 8;
/** Long edge the model gets. Claude reads at most ~1568px and other providers bill by
 *  pixels, so a 4K background would cost several times more for nothing it can see. */
export const MODEL_IMAGE_EDGE = 1568;

const REF_RE = /@asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What every provider behind the Studio reads (OpenAI, Anthropic, Gemini, Qwen). */
const MODEL_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const EXT_MIMES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** One stored file that an id resolved to, with who owns it. */
export interface AssetCandidate {
  id: string;
  /** "library": user_assets (owned by a user); "card": assets (owned by a world). */
  source: "library" | "card";
  ownerUserId: string | null;
  worldId: string | null;
  type: string;
  filename: string;
  /** The storage key (user_assets.url / assets.url). */
  key: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface AssetScope { userId: string; worldId: string }

export type SkipReason = "not_found" | "not_image" | "unsupported_format" | "too_large" | "over_limit" | "model_cannot_see";

export type AssetLook =
  | { ref: string; ok: true; filename: string; url: string }
  | { ref: string; ok: false; filename?: string; reason: SkipReason };

const refOf = (id: string) => `@asset:${id.toLowerCase()}`;

/** The asset ids a text names as `@asset:<uuid>`, once each, in order. */
export function assetRefIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(REF_RE)) {
    const id = match[1]!.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** `@asset:<uuid>` or a bare uuid → the id; anything else (a URL, a path) → null. */
export function parseAssetRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^@asset:/i, "");
  return UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/** Whether the file is this creator's: their library, or this card's own uploads. */
export function ownedBy(candidate: AssetCandidate, scope: AssetScope): boolean {
  return candidate.source === "library"
    ? candidate.ownerUserId === scope.userId
    : candidate.worldId === scope.worldId;
}

function pictureMime(candidate: AssetCandidate): string | null {
  const declared = candidate.mimeType?.split(";")[0]?.trim().toLowerCase();
  if (declared) return MODEL_IMAGE_MIMES.has(declared) ? declared : null;
  return EXT_MIMES[candidate.key.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/** Same rule as the app's cardImageUrl: hosts not behind Cloudflare answer /cdn-cgi/image with the SPA. */
function behindCloudflare(origin: string): boolean {
  try { return !/(^localhost$|^127\.|\.up\.railway\.app$)/i.test(new URL(origin).hostname); } catch { return false; }
}

/** The address the model fetches: our own /cdn for the stored key, scaled down at the edge
 *  when the site is behind Cloudflare (no `format`, so a provider that cannot read AVIF never
 *  gets one; a failed transform redirects to the original). Null for a key /cdn would not serve. */
export function modelImageUrl(key: string, origin: string = PUBLIC_ORIGIN): string | null {
  if (!key || /^[a-z][a-z0-9+.-]*:/i.test(key) || key.startsWith("//") || !isPublicCdnKey(key)) return null;
  const path = `/cdn/key/${Buffer.from(key, "utf-8").toString("base64url")}`;
  if (!behindCloudflare(origin)) return `${origin}${path}`;
  const edge = MODEL_IMAGE_EDGE;
  return `${origin}/cdn-cgi/image/width=${edge},height=${edge},fit=scale-down,quality=85,anim=false,onerror=redirect${path}`;
}

/**
 * What each requested id becomes for the model, in order. Pure: `candidates` is
 * every row the ids matched in either table; ownership is decided here, and a file
 * that is someone else's reads exactly like one that does not exist.
 */
export function judgeAssets(
  ids: string[],
  candidates: AssetCandidate[],
  scope: AssetScope,
  opts: { room: number; modelSeesImages?: boolean; origin?: string },
): AssetLook[] {
  let room = Math.max(0, opts.room);
  return ids.map((id): AssetLook => {
    const ref = refOf(id);
    const owned = candidates.find((c) => c.id.toLowerCase() === id && ownedBy(c, scope));
    if (!owned) return { ref, ok: false, reason: "not_found" };
    const filename = owned.filename;
    if (owned.type !== "image") return { ref, ok: false, filename, reason: "not_image" };
    const url = pictureMime(owned) ? modelImageUrl(owned.key, opts.origin) : null;
    if (!url) return { ref, ok: false, filename, reason: "unsupported_format" };
    if ((owned.sizeBytes ?? 0) > MAX_ASSET_IMAGE_BYTES) return { ref, ok: false, filename, reason: "too_large" };
    if (opts.modelSeesImages === false) return { ref, ok: false, filename, reason: "model_cannot_see" };
    if (room <= 0) return { ref, ok: false, filename, reason: "over_limit" };
    room--;
    return { ref, ok: true, filename, url };
  });
}

/** The rows these ids name among this creator's files. Ownership is in the query and checked again in judgeAssets. */
export async function loadOwnedAssetCandidates(ids: string[], scope: AssetScope): Promise<AssetCandidate[]> {
  if (ids.length === 0) return [];
  const [library, card] = await Promise.all([
    db.select({ id: userAssets.id, userId: userAssets.userId, type: userAssets.type, filename: userAssets.filename,
      key: userAssets.url, mimeType: userAssets.mimeType, sizeBytes: userAssets.sizeBytes })
      .from(userAssets).where(and(inArray(userAssets.id, ids), eq(userAssets.userId, scope.userId))),
    db.select({ id: assets.id, worldId: assets.worldId, type: assets.type, filename: assets.filename,
      key: assets.url, mimeType: assets.mimeType, sizeBytes: assets.sizeBytes })
      .from(assets).where(and(inArray(assets.id, ids), eq(assets.worldId, scope.worldId))),
  ]);
  return [
    ...library.map((r) => ({ id: r.id, source: "library" as const, ownerUserId: r.userId, worldId: null, type: r.type,
      filename: r.filename, key: r.key, mimeType: r.mimeType, sizeBytes: r.sizeBytes })),
    ...card.map((r) => ({ id: r.id, source: "card" as const, ownerUserId: null, worldId: r.worldId, type: r.type,
      filename: r.filename, key: r.key, mimeType: r.mimeType, sizeBytes: r.sizeBytes })),
  ];
}

/** Whether the model reads images: OpenRouter's catalog when it has been read, else our
 *  own table. Undefined when neither knows; then the picture is sent like an attachment
 *  and generateStreamWithRetry turns an OpenRouter refusal into a note. */
export function modelSeesImages(model: string): boolean | undefined {
  return getCatalogImageSupport(model);
}

const SKIP_TEXT: Record<SkipReason, string> = {
  not_found: "is not a file in this creator's library or this card, so it is not shown",
  not_image: "is not a picture (audio, video or another file), so it is not shown",
  unsupported_format: "is a picture in a format the model cannot read (only PNG, JPEG, WebP and GIF), so it is not shown",
  too_large: `is over ${MAX_ASSET_IMAGE_BYTES / 1024 / 1024} MB, so it is not shown`,
  over_limit: "is not shown: too many pictures at once",
  model_cannot_see: "is not shown: the selected model cannot see pictures (the creator can switch to one with image input)",
};

/** One line about a file, as the model reads it next to the picture or in its place. */
export function lookLabel(look: AssetLook): string {
  const name = look.filename ? ` ${JSON.stringify(look.filename)}` : "";
  return look.ok ? `[${look.ref}${name}:]` : `[${look.ref}${name} ${SKIP_TEXT[look.reason]}.]`;
}

/** Labels and pictures, in the order the files were named. */
export function lookParts(looks: AssetLook[]): ContentPart[] {
  return looks.flatMap((look): ContentPart[] => look.ok
    ? [{ type: "text", text: lookLabel(look) }, { type: "image_url", image_url: { url: look.url } }]
    : [{ type: "text", text: lookLabel(look) }]);
}

const imageCount = (content: ChatMessage["content"]) =>
  Array.isArray(content) ? content.filter((p) => p.type === "image_url").length : 0;

/**
 * The creator's message with every `@asset:` picture of theirs added as an image
 * part, the way an attached picture arrives. The words stay as typed (first
 * part); a reference that cannot be shown gets a line saying why. A message with
 * no references comes back unchanged.
 */
export async function expandAssetRefs(
  message: ChatMessage,
  scope: AssetScope,
  opts: { model: string; load?: typeof loadOwnedAssetCandidates; origin?: string },
): Promise<ChatMessage> {
  if (message.role !== "user") return message;
  const text = typeof message.content === "string" ? message.content
    : message.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  const ids = assetRefIds(text).slice(0, 20);
  if (ids.length === 0) return message;
  const candidates = await (opts.load ?? loadOwnedAssetCandidates)(ids, scope).catch((error) => {
    console.warn("[Agent] @asset lookup failed:", error instanceof Error ? error.message : error);
    return null;
  });
  if (!candidates) return message;
  const looks = judgeAssets(ids, candidates, scope, {
    room: MAX_MESSAGE_IMAGES - imageCount(message.content),
    modelSeesImages: modelSeesImages(opts.model),
    origin: opts.origin,
  });
  const base: ContentPart[] = typeof message.content === "string"
    ? [{ type: "text", text: message.content }] : message.content;
  return { role: "user", content: [...base, ...lookParts(looks)] };
}

/** view_asset: what the ids show, within this call's and this run's room. */
export async function viewAssets(
  input: Record<string, unknown>,
  scope: AssetScope,
  opts: { model: string; viewedThisRun: number; load?: typeof loadOwnedAssetCandidates; origin?: string },
): Promise<{ looks: AssetLook[]; error?: string }> {
  const raw = Array.isArray(input.assets) ? input.assets : input.asset !== undefined ? [input.asset] : [];
  const ids: string[] = [];
  for (const value of raw) {
    const id = parseAssetRef(value);
    if (!id) return { looks: [], error: `${JSON.stringify(value)} is not an @asset ref. Pass @asset:<id> refs from the creator's message, the card, or list_assets.` };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return { looks: [], error: "Pass assets: one or more @asset:<id> refs." };
  if (ids.length > MAX_VIEW_PER_CALL) return { looks: [], error: `At most ${MAX_VIEW_PER_CALL} pictures per call.` };
  const candidates = await (opts.load ?? loadOwnedAssetCandidates)(ids, scope);
  const looks = judgeAssets(ids, candidates, scope, {
    room: MAX_VIEWS_PER_RUN - opts.viewedThisRun,
    modelSeesImages: modelSeesImages(opts.model),
    origin: opts.origin,
  });
  return { looks };
}
