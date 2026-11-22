import { and, eq } from "drizzle-orm";
import { mediaTool } from "@yumina/shared";
import { db } from "../../db/index.js";
import { generationJobs } from "../../db/schema.js";
import { MediaToolError, validateToolInputs, type ToolValues } from "../generation/media-tools.js";
import type { ChatMessage, ToolCall } from "../llm/types.js";
import type { ToolResult } from "./index.js";
import { buildToolResultMessages } from "./tool-results.js";
import { GET_MEDIA_JOB_NAME, RUN_MEDIA_TOOL_NAME } from "./media-tool-defs.js";

/** run_media_tool's arguments, checked: the tool and its inputs with defaults filled. */
export function normalizeMediaToolArgs(args: Record<string, unknown>): { tool: string; inputs: ToolValues } | { error: string } {
  const tool = typeof args.tool === "string" ? mediaTool(args.tool) : undefined;
  if (!tool) return { error: "Unknown tool. Pick one of the ids listed in run_media_tool." };
  try {
    return { tool: tool.id, inputs: validateToolInputs(tool, args.inputs ?? {}) };
  } catch (error) {
    return { error: error instanceof MediaToolError ? `${error.message}.` : "Invalid inputs." };
  }
}

export function mediaToolMessages(call: ToolCall, result: Omit<ToolResult, "tool_call_id" | "name">): ChatMessage[] {
  return buildToolResultMessages([{ tool_call_id: call.id, name: RUN_MEDIA_TOOL_NAME, ...result }]) as unknown as ChatMessage[];
}

/** get_media_job's answer: a tool job of this person's, with its outputs as @asset refs. */
export async function mediaJobResult(userId: string, jobId: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) return { ok: false, error: `${GET_MEDIA_JOB_NAME} needs the jobId run_media_tool returned.` };
  const [job] = await db.select().from(generationJobs)
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, userId), eq(generationJobs.kind, "tool"))).limit(1);
  if (!job) return { ok: false, error: "No such media tool job." };
  const assetIds = job.assetIds?.length ? job.assetIds : job.assetId ? [job.assetId] : [];
  return { ok: true, result: {
    jobId: job.id, tool: job.templateId, status: job.status, costMushies: job.costMushies,
    ...(job.status === "succeeded" ? { assets: assetIds.map((id) => ({ assetId: id, ref: `@asset:${id}` })) } : {}),
    ...(job.status === "failed" || job.status === "cancelled" ? { errorCode: job.errorCode, refunded: job.refunded || (job.refundAmount ?? 0) > 0 } : {}),
    ...(job.status === "queued" || job.status === "running" ? { note: `About ${mediaTool(job.templateId)?.seconds ?? 60} s in all. Check again later; do not run it again.` } : {}),
  } };
}

const POLL_MS = 2_000;

/**
 * Follows a confirmed run until it lands, narrating to the card, and returns the tool messages the
 * assistant continues with. A long tool (lipsync takes minutes) outlives the wait: the model is told
 * it will land and given the job id for get_media_job.
 */
export async function waitForMediaTool(opts: {
  call: ToolCall; jobId: string; runId: string; folderId: string | null;
  send: (event: string, data: string) => Promise<void>; progress: () => void; timeoutMs?: number;
}): Promise<ChatMessage[]> {
  const { call, jobId, runId, folderId, send, progress } = opts;
  const deadline = Date.now() + (opts.timeoutMs ?? 150_000);
  const startedAt = Date.now();
  for (;;) {
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    if (!job) {
      await send("media_tool_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "failed", errorCode: "JOB_MISSING" }));
      return mediaToolMessages(call, { status: "error", result: null, error: "The tool job disappeared before it finished. Tell the creator and continue without it." });
    }
    progress();
    if (job.status === "succeeded") {
      const assetIds = job.assetIds?.length ? job.assetIds : job.assetId ? [job.assetId] : [];
      await send("media_tool_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "done", assetIds, costMushies: job.costMushies }));
      return mediaToolMessages(call, { status: "success", result: {
        tool: job.templateId, assets: assetIds.map((id) => ({ assetId: id, ref: `@asset:${id}` })), costMushies: job.costMushies, folderId,
        note: "The creator has already seen the result in the chat. Reference it by its ref; place it where it belongs (write_entry / edit_custom_ui / write_audio) if that was the plan. One short sentence, then end your turn.",
      } });
    }
    if (job.status === "failed" || job.status === "cancelled") {
      await send("media_tool_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "failed", errorCode: job.errorCode ?? job.status }));
      return mediaToolMessages(call, { status: "error", result: null,
        error: `The tool ${job.status}${job.errorCode ? ` (${job.errorCode})` : ""}. Any charge is refunded automatically.${job.errorCode === "CONTENT_FILTERED" ? " The provider refused this content." : ""} Do not run it again in this turn: tell the creator plainly and end your turn.` });
    }
    await send("media_tool_progress", JSON.stringify({ runId, toolCallId: call.id, jobId, status: job.status, elapsed: Math.round((Date.now() - startedAt) / 1000) }));
    if (Date.now() >= deadline) {
      await send("media_tool_result", JSON.stringify({ runId, toolCallId: call.id, jobId, status: "pending" }));
      return mediaToolMessages(call, { status: "success", result: {
        pending: true, jobId, folderId,
        note: "Still running after the wait limit; it lands in the creator's asset library when done. Tell the creator that, do not run it again; get_media_job with this jobId gives the result later.",
      } });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
