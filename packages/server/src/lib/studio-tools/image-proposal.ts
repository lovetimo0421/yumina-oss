import { SMART_IMAGE_ASPECTS, SMART_IMAGE_MODEL, resolveSmartImageAspect, resolveSmartImageResolution } from "@yumina/shared";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { generationJobs } from "../../db/schema.js";
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

export interface ImageProposal {
  prompt: string;
  /** What the picture is for, in the creator's words — shown on the card. */
  purpose?: string;
  aspectRatio: ImageAspect;
  /** Output size tier. Absent means the pinned model's default. */
  resolution?: string;
  batchSize: number;
}

const MAX_PROMPT = 2000;

/** Shape-check the model's (or the creator's edited) arguments. Null = unusable. */
export function normalizeImageProposal(raw: unknown): ImageProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const prompt = typeof r.prompt === "string" ? r.prompt.trim().slice(0, MAX_PROMPT) : "";
  if (!prompt) return null;
  // Narrow to what the pinned model accepts rather than to the union: a model
  // rejects a ratio it does not know, and the creator would see the card fail
  // after confirming it.
  const aspect = resolveSmartImageAspect(SMART_IMAGE_MODEL,
    typeof r.aspectRatio === "string" ? r.aspectRatio : undefined) as ImageAspect;
  const resolution = resolveSmartImageResolution(SMART_IMAGE_MODEL,
    typeof r.resolution === "string" ? r.resolution : undefined);
  void SMART_IMAGE_ASPECTS;
  const batchRaw = typeof r.batchSize === "number" ? r.batchSize : Number(r.batchSize ?? 1);
  const batchSize = Number.isFinite(batchRaw) ? Math.min(4, Math.max(1, Math.round(batchRaw))) : 1;
  const purpose = typeof r.purpose === "string" && r.purpose.trim() ? r.purpose.trim().slice(0, 200) : undefined;
  return { prompt, purpose, aspectRatio: aspect, ...(resolution ? { resolution } : {}), batchSize };
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
