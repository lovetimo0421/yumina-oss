import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { generationJobs, userAssets, worldFolderBindings, worlds } from "../db/schema.js";
import { isSmartGenerationEnabled, submitSmartGeneration, SmartSubmissionError } from "./generation/smart.js";
import type { ToolDefinition } from "./llm/types.js";
import { normalizeImageProposal } from "./studio-tools/image-proposal.js";
import { STUDIO_TOOLS } from "./studio-tools/tools.js";

/**
 * Pictures for an AI that is not ours. In the Studio the assistant only
 * proposes an image and the creator presses Generate; an outside AI has no
 * such card, so it generates directly — through the same generator, billed
 * to the creator at the same price, with a per-hour cap — and can make an
 * image the cover of a card that is not yet published.
 */

/** Images an outside AI may generate for one creator per hour (per instance). */
export const IMAGES_PER_HOUR = 20;
const imageTimes = new Map<string, number[]>();

function takeImage(userId: string): boolean {
  const now = Date.now();
  const recent = (imageTimes.get(userId) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= IMAGES_PER_HOUR) { imageTimes.set(userId, recent); return false; }
  recent.push(now);
  imageTimes.set(userId, recent);
  return true;
}

const studioImageTool = STUDIO_TOOLS.find((t) => t.function.name === "generate_image");
const studioParams = (studioImageTool?.function.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };

export const GENERATE_IMAGE: ToolDefinition = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate one picture with Yumina's image generator and save it to the creator's assets. It COSTS the creator mushies at the normal price (shown as costMushies in the result) and takes up to a minute or two; at most " +
      `${IMAGES_PER_HOUR} an hour. Use it only for a picture the card needs (a portrait, a scene, a map, a cover) — never to decorate on your own initiative. ` +
      "Write `prompt` in English as a concrete visual description: subject, setting, style, lighting, composition; never text or UI inside the picture. " +
      "The result gives an `@asset:<id>` ref: place it with write_entry / edit_custom_ui like any asset, or make it the cover with set_cover.",
    parameters: {
      type: "object",
      properties: {
        prompt: studioParams.properties?.prompt ?? { type: "string" },
        ...(studioParams.properties?.model ? { model: studioParams.properties.model } : {}),
        ...(studioParams.properties?.aspectRatio ? { aspectRatio: studioParams.properties.aspectRatio } : {}),
      },
      required: ["prompt"],
    },
  },
};

export const SET_COVER: ToolDefinition = {
  type: "function",
  function: {
    name: "set_cover",
    description: "Make one of the creator's images (an @asset ref or asset id, e.g. from generate_image) the card's cover. Only for a card that is not published yet; a published card's cover is changed by the creator in the editor.",
    parameters: {
      type: "object",
      properties: { asset: { type: "string", description: "`@asset:<id>` or the asset id." } },
      required: ["asset"],
    },
  },
};

const POLL_MS = 2_000;
const WAIT_MS = 120_000;

export async function runGenerateImage(args: { userId: string; worldId: string; input: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const { userId, worldId, input } = args;
  if (!isSmartGenerationEnabled()) return { ok: false, error: "Image generation is not available right now." };
  const proposal = normalizeImageProposal({ prompt: input.prompt, model: input.model, aspectRatio: input.aspectRatio, batchSize: 1 });
  if (!proposal) return { ok: false, error: "Give a prompt: a concrete visual description in English." };
  if (!takeImage(userId)) return { ok: false, error: `Image limit reached: ${IMAGES_PER_HOUR} an hour. Try again later.` };

  // The card's first bound folder is where its pictures live (as in the Studio).
  const [binding] = await db.select({ folderId: worldFolderBindings.folderId }).from(worldFolderBindings)
    .where(eq(worldFolderBindings.worldId, worldId)).orderBy(asc(worldFolderBindings.createdAt)).limit(1);
  const folderId = binding?.folderId ?? null;

  let jobId: string;
  try {
    const requestId = crypto.randomUUID();
    let submitted: Awaited<ReturnType<typeof submitSmartGeneration>> | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        submitted = await submitSmartGeneration(userId, {
          prompt: proposal.prompt,
          requestId,
          cloud: { billing: "actual-v1", model: proposal.model as never, aspectRatio: proposal.aspectRatio as never,
            ...(proposal.resolution ? { resolution: proposal.resolution as never } : {}), batchSize: 1 },
          ...(folderId ? { folderId } : {}),
        });
        break;
      } catch (error) {
        if (error instanceof SmartSubmissionError && error.code === "GENERATION_BUSY" && attempt < 4) {
          await new Promise((r) => setTimeout(r, 1000 + attempt * 500));
          continue;
        }
        throw error;
      }
    }
    jobId = submitted.job.id;
  } catch (error) {
    const code = error instanceof SmartSubmissionError ? error.code : "SUBMIT_FAILED";
    return { ok: false, error: `Image generation could not start (${code}). Nothing was charged.${code === "NO_CREDITS" || code === "INSUFFICIENT_CREDITS" ? " The creator needs more mushies." : ""}` };
  }

  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const [job] = await db.select({ status: generationJobs.status, assetIds: generationJobs.assetIds, assetId: generationJobs.assetId,
      costMushies: generationJobs.costMushies, errorCode: generationJobs.errorCode })
      .from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
    if (!job) return { ok: false, error: "The image job disappeared before it finished." };
    if (job.status === "succeeded") {
      const ids = job.assetIds?.length ? job.assetIds : job.assetId ? [job.assetId] : [];
      return { ok: true, result: { assets: ids.map((id) => ({ assetId: id, ref: `@asset:${id}` })), costMushies: job.costMushies } };
    }
    if (job.status === "failed" || job.status === "cancelled") {
      return { ok: false, error: `Image generation ${job.status}${job.errorCode ? ` (${job.errorCode})` : ""}. Any charge is refunded automatically.` };
    }
  }
  return { ok: true, result: { pending: true, jobId, note: "Still generating after two minutes; it will land in the creator's assets. Do not generate it again." } };
}

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
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId))).limit(1);
  if (!card) return { ok: false, error: "Card not found." };
  if (card.isPublished || card.status === "published") {
    return { ok: false, error: "This card is published: its cover goes through review, so the creator changes it in the editor (Overview → cover)." };
  }
  await db.update(worlds).set({ thumbnailUrl: asset.url, updatedAt: new Date() }).where(eq(worlds.id, worldId));
  return { ok: true, result: { cover: `@asset:${assetId}` } };
}
