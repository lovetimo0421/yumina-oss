import { IMAGE_ASPECTS, PLATFORM_STYLES, SMART_IMAGE_ASPECTS, SMART_IMAGE_MODEL, SMART_IMAGE_MODEL_IDS, closestAspect,
  getPlatformStyle, getSmartImageModel, platformStylePrice, platformStyleRecipe,
  resolveSmartImageAspect, resolveSmartImageResolution, type ImageAspectId } from "@yumina/shared";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { generationJobs } from "../../db/schema.js";
import type { CustomSubmission } from "../generation/custom.js";
import type { ChatMessage, ToolCall } from "../llm/types.js";
import type { ToolResult } from "./index.js";
import { buildToolResultMessages } from "./tool-results.js";

/**
 * `generate_image` is a control tool: the model proposes, the creator confirms
 * in the chat, and only then does the server create a paid job on the
 * creator's behalf. This module holds the pieces both the pause (agent loop)
 * and the resume (confirm route) share.
 */
export const IMAGE_TOOL_NAME = "generate_image";

export type ImageAspect = (typeof SMART_IMAGE_ASPECTS)[number];

/** 描述生图 (smart: OpenRouter models) or 自定义生图 (custom: a platform base
 *  model on our ComfyUI workers, template image-anime). */
export type ImageProposalMode = "smart" | "custom";

export interface ImageProposal {
  prompt: string;
  /** What the picture is for, in the creator's words — shown on the card. */
  purpose?: string;
  mode: ImageProposalMode;
  /** Which smart generator to run (smart mode). The assistant chooses; an
   *  unknown value falls back to the default rather than reaching a provider
   *  that does not exist. */
  model: string;
  /** Platform base model slug (custom mode only). */
  style?: string;
  /** Why that generator, in the creator's language. Rendered on the card in a
   *  fixed slot rather than left to the assistant's prose, so the disclosure
   *  happens every time and reads the same way. */
  modelReason?: string;
  /** Smart mode: a ratio the chosen model accepts ("2:3").
   *  Custom mode: an SDXL-native size id from IMAGE_ASPECTS ("portrait"). */
  aspectRatio: string;
  /** Output size tier (smart mode). Absent means the chosen model's own default. */
  resolution?: string;
  batchSize: number;
}

const MAX_PROMPT = 2000;

/** Custom mode renders at SDXL-native sizes only. The assistant may name one
 *  directly or give a ratio, which snaps to the nearest native size. */
export function resolveCustomAspect(requested: unknown): ImageAspectId {
  if (typeof requested === "string") {
    const byId = IMAGE_ASPECTS.find(a => a.id === requested);
    if (byId) return byId.id;
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(requested.trim());
    if (match && Number(match[1]) > 0 && Number(match[2]) > 0) {
      return closestAspect(Number(match[1]), Number(match[2])).id;
    }
  }
  return IMAGE_ASPECTS[0].id;
}

export interface NormalizeImageOptions {
  /** Base-model slugs custom mode may use right now. Absent or empty means
   *  custom generation is unavailable, and a custom request becomes smart. */
  customStyles?: readonly string[];
  /** Whether smart generation is available. Defaults to true. When it is not
   *  and custom is, a proposal lands on custom instead. */
  smartAvailable?: boolean;
}

/** Shape-check the model's (or the creator's edited) arguments. Null = unusable. */
export function normalizeImageProposal(raw: unknown, options: NormalizeImageOptions = {}): ImageProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const prompt = typeof r.prompt === "string" ? r.prompt.trim().slice(0, MAX_PROMPT) : "";
  if (!prompt) return null;
  const batchRaw = typeof r.batchSize === "number" ? r.batchSize : Number(r.batchSize ?? 1);
  const batchSize = Number.isFinite(batchRaw) ? Math.min(4, Math.max(1, Math.round(batchRaw))) : 1;
  const purpose = typeof r.purpose === "string" && r.purpose.trim() ? r.purpose.trim().slice(0, 200) : undefined;
  const modelReason = typeof r.modelReason === "string" && r.modelReason.trim()
    ? r.modelReason.trim().slice(0, 160) : undefined;

  const customStyles = options.customStyles ?? [];
  const wantsCustom = r.mode === "custom" || (options.smartAvailable === false && customStyles.length > 0);
  if (wantsCustom && customStyles.length > 0) {
    // An unknown or not-ready base model falls back to the first one on offer,
    // never to a checkpoint the worker does not have.
    const style = typeof r.style === "string" && customStyles.includes(r.style) && getPlatformStyle(r.style)
      ? r.style : customStyles[0]!;
    return { prompt, purpose, mode: "custom", model: "image-anime", style,
      ...(modelReason ? { modelReason } : {}),
      aspectRatio: resolveCustomAspect(r.aspectRatio), batchSize };
  }

  // Resolve the model first: everything else is narrowed against IT, not against
  // the union the schema advertises. A model rejects a ratio it does not know,
  // and the creator would only find out after confirming the card.
  const model = typeof r.model === "string" && (SMART_IMAGE_MODEL_IDS as readonly string[]).includes(r.model)
    && getSmartImageModel(r.model)
    ? r.model
    : SMART_IMAGE_MODEL;
  const aspect = resolveSmartImageAspect(model,
    typeof r.aspectRatio === "string" ? r.aspectRatio : undefined);
  const resolution = resolveSmartImageResolution(model,
    typeof r.resolution === "string" ? r.resolution : undefined);
  return { prompt, purpose, mode: "smart", model, ...(modelReason ? { modelReason } : {}),
    aspectRatio: aspect, ...(resolution ? { resolution } : {}), batchSize };
}

/** Every base-model slug, for re-reading a proposal that was already
 *  normalized when it paused: its mode was decided then and must not flip. */
export const ALL_PLATFORM_STYLE_SLUGS = PLATFORM_STYLES.map(style => style.slug);

/** Price a custom proposal exactly as POST /generation/jobs will charge it. */
export function customProposalPrice(proposal: ImageProposal) {
  const style = proposal.style ?? "anime";
  return {
    unitMushies: platformStylePrice(style, proposal.aspectRatio, 1),
    estimatedMushies: platformStylePrice(style, proposal.aspectRatio, proposal.batchSize),
  };
}

/** The custom-mode submission for a confirmed proposal — the same body the
 *  creator's 自定义生图 page sends after picking this base model: the style's
 *  recommended recipe, the prompt verbatim, no hidden rewrite. */
export function customSubmissionFor(proposal: ImageProposal, opts: { requestId: string; folderId?: string | null }): CustomSubmission {
  const style = proposal.style ?? "anime";
  const recipe = platformStyleRecipe(style, proposal.aspectRatio, proposal.batchSize);
  return {
    requestId: opts.requestId,
    templateId: "image-anime",
    prompt: proposal.prompt,
    ...(opts.folderId ? { folderId: opts.folderId } : {}),
    advanced: recipe,
    ...(style !== "anime" ? { style } : {}),
  };
}

export function imageToolMessages(call: ToolCall, result: Omit<ToolResult, "tool_call_id" | "name">): ChatMessage[] {
  return buildToolResultMessages([{ tool_call_id: call.id, name: IMAGE_TOOL_NAME, ...result }]) as unknown as ChatMessage[];
}

const POLL_MS = 2_000;

/**
 * Follows a submitted job until it settles, narrating progress to the client,
 * and returns the tool messages the model continues with. A job that outlives
 * the wait is not an error: the image still lands in the library, and the model
 * is told to say so rather than retry.
 */
export async function waitForGeneratedImage(opts: {
  call: ToolCall;
  jobId: string;
  runId: string;
  folderId: string | null;
  send: (event: string, data: string) => Promise<void>;
  progress: () => void;
  timeoutMs?: number;
}): Promise<ChatMessage[]> {
  const { call, jobId, runId, folderId, send, progress } = opts;
  const deadline = Date.now() + (opts.timeoutMs ?? 150_000);
  const startedAt = Date.now();
  let lastStatus = "";
  for (;;) {
    const [job] = await db.select({
      status: generationJobs.status, assetIds: generationJobs.assetIds, assetId: generationJobs.assetId,
      costMushies: generationJobs.costMushies, errorCode: generationJobs.errorCode, refundAmount: generationJobs.refundAmount,
    }).from(generationJobs).where(eq(generationJobs.id, jobId));
    if (!job) {
      await send("image_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "failed", errorCode: "JOB_MISSING" }));
      return imageToolMessages(call, { status: "error", result: null, error: "The image job disappeared before it finished. Tell the creator and continue without it." });
    }
    progress();
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (job.status === "succeeded") {
      const assetIds = job.assetIds?.length ? job.assetIds : job.assetId ? [job.assetId] : [];
      await send("image_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "done", assetIds, costMushies: job.costMushies }));
      return imageToolMessages(call, { status: "success", result: {
        delivered: assetIds.length,
        assets: assetIds.map((id) => ({ assetId: id, ref: `@asset:${id}` })),
        costMushies: job.costMushies,
        folderId,
        note: "The creator has already seen the image in the chat. Reference it by its ref only. If it belongs in custom UI or an entry, place it there with edit_custom_ui / write_entry. No tool sets the card cover: for a cover, say the image is saved and the creator can pick it as the cover in the editor overview. One short sentence, then end your turn.",
      } });
    }
    if (job.status === "failed" || job.status === "cancelled") {
      await send("image_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "failed", errorCode: job.errorCode ?? job.status }));
      return imageToolMessages(call, { status: "error", result: null,
        error: `Image generation ${job.status}${job.errorCode ? ` (${job.errorCode})` : ""}. Any charge is refunded automatically. Do not call generate_image again in this turn: tell the creator plainly, ask whether to try again, and end your turn.` });
    }
    if (job.status !== lastStatus) {
      lastStatus = job.status;
    }
    await send("image_progress", JSON.stringify({ runId, toolCallId: call.id, jobId, status: job.status, elapsed }));
    if (Date.now() >= deadline) {
      await send("image_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "pending" }));
      return imageToolMessages(call, { status: "success", result: {
        delivered: 0, pending: true, jobId, folderId,
        note: "The image is still generating after the wait limit. It will appear in the creator's asset library (and the bound folder) when done. Tell the creator that, do not retry, and continue.",
      } });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
