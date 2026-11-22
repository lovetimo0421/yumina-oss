/**
 * set_cover for an outside AI (Connect your AI): make one of the creator's own
 * images the card's cover. It needs no generation provider, so it lives here,
 * in both editions, apart from the hosted picture tools in outside-ai-media.ts.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { userAssets, worlds } from "../db/schema.js";
import type { ToolDefinition } from "./llm/types.js";
import { SET_COVER_TOOL } from "./studio-tools/tools.js";
import { canEditWorldSql } from "./world-collaborators.js";

export const SET_COVER: ToolDefinition = { ...SET_COVER_TOOL, function: { ...SET_COVER_TOOL.function, description: SET_COVER_TOOL.function.description.replace(" Auto-executes.", "") } };

export async function runSetCover(args: { userId: string; worldId: string; input: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const { userId, worldId, input } = args;
  const raw = typeof input.asset === "string" ? input.asset.trim() : "";
  const assetId = raw.replace(/^@asset:/, "");
  if (!assetId) return { ok: false, error: "Give the image as @asset:<id>." };
  const [asset] = await db.select({ url: userAssets.url, mimeType: userAssets.mimeType }).from(userAssets)
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, userId))).limit(1);
  if (!asset) return { ok: false, error: "No such image among the creator's assets." };
  if (asset.mimeType && !asset.mimeType.startsWith("image/")) return { ok: false, error: "That asset is not an image." };
  const [card] = await db.select({ status: worlds.status, isPublished: worlds.isPublished }).from(worlds)
    .where(and(eq(worlds.id, worldId), canEditWorldSql(userId))).limit(1);
  if (!card) return { ok: false, error: "Card not found." };
  if (card.isPublished || card.status === "published") {
    return { ok: false, error: "This card is published: its cover goes through review, so the creator changes it in the editor (Overview → cover)." };
  }
  await db.update(worlds).set({ thumbnailUrl: asset.url, updatedAt: new Date() }).where(eq(worlds.id, worldId));
  return { ok: true, result: { cover: `@asset:${assetId}` } };
}