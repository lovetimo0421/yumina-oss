// The picture a live character is made from, when the creator attached it to their message in the Studio chat
// instead of picking one from their library.
//
// A chat attachment is only an object under studio-chat/<user>/ that the model sees as an image; it has no asset id
// to hand a tool, and on 2026-11-01 a model without one picked an unrelated picture from the library instead. So the
// tool takes "attached", and the picture is copied into the creator's library here: once per attachment (the asset id
// comes from the attachment's own id, so asking again finds the same asset and the same character).

import { createHash } from "node:crypto";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { userAssets } from "../../db/schema.js";
import { getObjectBuffer, putObject } from "../s3.js";
import type { ChatMessage } from "../llm/types.js";

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** The storage keys of the pictures this user attached in the conversation, oldest first. */
export function attachedPictureKeys(messages: ChatMessage[], userId: string): string[] {
  const pattern = new RegExp(`studio-chat/${userId}/[0-9a-f-]{36}\\.(?:png|jpe?g|webp|gif)`, "i");
  const keys: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type !== "image_url") continue;
      let url = part.image_url.url;
      try { url = decodeURIComponent(url); } catch { /* keep it as it is */ }
      // The app sends its own address for the file: /cdn/key/<the storage key, base64url>
      const encoded = url.match(/\/cdn\/key\/([A-Za-z0-9_-]+)/)?.[1];
      if (encoded) {
        try { url = `${url} ${Buffer.from(encoded, "base64url").toString("utf8")}`; } catch { /* not ours */ }
      }
      const key = url.match(pattern)?.[0];
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/** The library asset for an attached picture, made on first use. */
export async function libraryAssetForAttachment(userId: string, key: string): Promise<string> {
  const hex = createHash("sha256").update(`${userId}:${key}`).digest("hex");
  // A UUID made from the attachment, so the same attachment is always the same asset.
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const [kept] = await db.select({ id: userAssets.id }).from(userAssets).where(and(eq(userAssets.id, id), eq(userAssets.userId, userId)));
  if (kept) return id;
  const ext = (key.split(".").pop() ?? "png").toLowerCase();
  const { buffer: bytes } = await getObjectBuffer(key);
  const target = `users/${userId}/image/attached/${id}.${ext}`;
  await putObject(target, bytes, TYPES[ext] ?? "image/png", { signal: AbortSignal.timeout(60_000) });
  await db.insert(userAssets).values({
    id, userId, type: "image", filename: `picture.${ext}`, url: target, sizeBytes: bytes.length, mimeType: TYPES[ext] ?? "image/png",
  }).onConflictDoNothing();
  return id;
}

/** The picture as the rig deployment gets it: a picture with transparency laid on white first. ComfyUI's LoadImage
 *  drops the alpha and keeps whatever colour the transparent pixels hold, so a cut-out standee arrived with its soft
 *  hair edges solid black and the hidden colours under the transparent background showing as blocks; every layer and
 *  the turns were built from that (2026-11-11). A picture without transparency goes as it is. */
export async function pictureOnWhite(bytes: Buffer, extension: string): Promise<{ bytes: Buffer; name: string }> {
  const meta = await sharp(bytes).metadata().catch(() => null);
  if (!meta?.hasAlpha) return { bytes, name: `picture.${extension === "jpeg" ? "jpg" : extension}` };
  const flat = await sharp(bytes).flatten({ background: { r: 255, g: 255, b: 255 } }).png().toBuffer();
  return { bytes: flat, name: "picture.png" };
}
