import { createHash } from "node:crypto";
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";
import { CHAT_IMAGE_MIME_TYPES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGE_TOTAL_BYTES, type ChatImageInput, type ImageCompletionMessage } from "@yumina/shared";
import type { ChatMessage, MessageContent, ContentPart } from "./llm/types.js";
import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { putObject, getObjectBuffer } from "./s3.js";
import { PUBLIC_ORIGIN } from "./env.js";

export async function validateChatImages(value: unknown): Promise<ChatImageInput[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_IMAGES) throw new Error(`Use up to ${MAX_CHAT_IMAGES} images per message.`);
  let total = 0;
  const result: ChatImageInput[] = [];
  for (const a of value) {
    if (!a || a.type !== "image" || !CHAT_IMAGE_MIME_TYPES.includes(a.mimeType) || typeof a.data !== "string"
      || a.data.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4
      || (a.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data))) {
      throw new Error("Use a PNG, JPEG, WebP or GIF image, up to 8 MB.");
    }
    const bytes = Buffer.from(a.data, "base64");
    total += bytes.length;
    if (!bytes.length || bytes.length > MAX_CHAT_IMAGE_BYTES || total > MAX_CHAT_IMAGE_TOTAL_BYTES) throw new Error("Images must total 16 MB or less.");
    const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    const mime = meta.format === "jpeg" ? "image/jpeg" : `image/${meta.format}`;
    if (mime !== a.mimeType || !meta.width || !meta.height) throw new Error("Image data does not match its format.");
    result.push({ type: "image", mimeType: mime, name: typeof a.name === "string" ? a.name.slice(0, 200) : "image", data: a.data });
  }
  return result;
}

export function imageContent(text: string, images: Array<{ url: string }>): MessageContent {
  if (!images.length) return text;
  return [...(text ? [{ type: "text" as const, text }] : []), ...images.map(image => ({ type: "image_url" as const, image_url: { url: image.url } }))];
}

/** Content-addressed per owner: retries reuse objects, never huge base64 DB rows. */
export async function storeChatImages(userId: string, images: ChatImageInput[]) {
  return Promise.all(images.map(async a => {
    const buffer = Buffer.from(a.data, "base64");
    const key = `users/${userId}/chat-images/${createHash("sha256").update(buffer).digest("hex")}`;
    await putObject(key, buffer, a.mimeType);
    return { type: "image", mimeType: a.mimeType, name: a.name, storageKey: key,
      url: `${PUBLIC_ORIGIN}/cdn/key/${Buffer.from(key).toString("base64url")}` };
  }));
}

/** Associate by row ID after prompt trimming, never by matching message text. */
export async function restoreChatImages(sessionId: string, prompt: Array<{ role: "user" | "assistant" | "system"; content: string; sourceMessageId?: string }>): Promise<ChatMessage[]> {
  const ids = prompt.filter(m => m.role === "user" && m.sourceMessageId).map(m => m.sourceMessageId!);
  if (!ids.length) return prompt.map(m => ({ role: m.role, content: m.content }));
  const rows = await db.select({ id: messages.id, attachments: messages.attachments }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), inArray(messages.id, ids)));
  const byId = new Map(rows.map(row => [row.id, row.attachments]));
  return Promise.all(prompt.map(async m => {
    const stored = m.role === "user" && m.sourceMessageId ? byId.get(m.sourceMessageId) : undefined;
    const images = await Promise.all((stored ?? []).filter(a => a.type === "image").map(async a => {
      const key = (a as typeof a & { storageKey?: string }).storageKey;
      if (key) {
        if (!/^users\/[^/]+\/chat-images\/[a-f0-9]{64}$/.test(key)) throw new Error("Invalid stored image.");
        const object = await getObjectBuffer(key, { maxBytes: MAX_CHAT_IMAGE_BYTES });
        return { url: `data:${a.mimeType};base64,${object.buffer.toString("base64")}` };
      }
      // Old truncated placeholders are not images and must not reach a provider.
      if (a.url.startsWith("data:image/") && !a.url.endsWith("...")) return { url: a.url };
      return null;
    }));
    const text = images.some(image => image === null)
      ? `${m.content}\n[An older attached image is unavailable. Ask the player to attach it again if needed.]` : m.content;
    return { role: m.role, content: imageContent(text, images.filter((image): image is { url: string } => image !== null)) };
  }));
}

async function completionImage(url: string): Promise<ChatImageInput> {
  const match = /^data:(image\/[^;]+);base64,([\s\S]+)$/.exec(url);
  if (match) return { type: "image", mimeType: match[1]!, data: match[2]!, name: "image" };
  // Resolve only our public CDN key format through storage, never fetch an
  // arbitrary user URL or follow redirects into internal services.
  const parsed = new URL(url, PUBLIC_ORIGIN);
  if (parsed.origin !== new URL(PUBLIC_ORIGIN).origin || !parsed.pathname.startsWith("/cdn/key/")) {
    throw new Error("Pass image bytes as a data URL, attachments, or a Yumina CDN image URL.");
  }
  const key = Buffer.from(parsed.pathname.slice("/cdn/key/".length), "base64url").toString("utf8");
  if (!/^(worlds|reports|studio-chat|users|bundles|dm|community)\//.test(key) || key.includes("..")) throw new Error("Invalid image URL.");
  const object = await getObjectBuffer(key, { maxBytes: MAX_CHAT_IMAGE_BYTES });
  return { type: "image", mimeType: object.contentType, data: object.buffer.toString("base64"), name: "image" };
}

/** Creator API accepts the same attachments, or standard data-URL image parts. */
export async function normalizeImageCompletion(input: ImageCompletionMessage[]): Promise<ChatMessage[]> {
  let imageCount = 0;
  let imageBytes = 0;
  const result: ChatMessage[] = [];
  for (const m of input) {
    if (!m || !["system", "user", "assistant"].includes(m.role)) throw new Error("Invalid message role.");
    const ordered: Array<{ type: "text"; text: string } | { type: "image"; index: number }> = [];
    const attachments: unknown[] = [];
    if (typeof m.content === "string") ordered.push({ type: "text", text: m.content });
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === "text" && typeof part.text === "string") ordered.push({ type: "text", text: part.text });
        else if (part?.type === "image_url") {
          if (attachments.length >= MAX_CHAT_IMAGES) throw new Error("Use up to 4 images per call.");
          ordered.push({ type: "image", index: attachments.length });
          attachments.push(await completionImage(part.image_url?.url ?? ""));
        } else throw new Error("Invalid message content.");
      }
    } else throw new Error("Invalid message content.");
    for (const attachment of m.attachments ?? []) {
      ordered.push({ type: "image", index: attachments.length });
      attachments.push(attachment);
    }
    if (attachments.length && m.role !== "user") throw new Error("Images must belong to user messages.");
    const images = await validateChatImages(attachments);
    imageCount += images.length;
    imageBytes += images.reduce((sum, image) => sum + Buffer.byteLength(image.data, "base64"), 0);
    if (imageCount > MAX_CHAT_IMAGES || imageBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) throw new Error("Use up to 4 images totaling 16 MB per call.");
    const content: MessageContent = images.length ? ordered.flatMap<ContentPart>(part => {
      if (part.type === "text") return part.text ? [part] : [];
      const a = images[part.index]!;
      return [{ type: "image_url" as const, image_url: { url: `data:${a.mimeType};base64,${a.data}` } }];
    }) : ordered.map(part => part.type === "text" ? part.text : "").join("");
    result.push({ role: m.role as "user" | "system" | "assistant", content });
  }
  return result;
}

/** Base64 is transport overhead, not millions of text tokens. */
export function imagePromptChars(prompt: Array<{ content: MessageContent }>): number {
  return prompt.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : m.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 6400), 0)), 0);
}
