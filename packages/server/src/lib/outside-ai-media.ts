/**
 * Open-source edition stub. Picture generation and the media tools an outside
 * AI (Connect your AI) can run are hosted, credit-metered features. The tool
 * definitions stay so the MCP tool list typechecks; mediaToolsEnabled() is
 * false here, so the media tools are never listed, and generate_image reports
 * itself unavailable. set_cover needs no provider and lives in
 * outside-ai-cover.ts, shared with the hosted build.
 */
import { PUBLIC_ORIGIN } from "./env.js";
import type { ToolDefinition } from "./llm/types.js";
import { GET_MEDIA_JOB_DEFINITION, LIST_MEDIA_TOOLS_DEFINITION, runMediaToolDefinition } from "./studio-tools/media-tool-defs.js";

export { SET_COVER, runSetCover } from "./outside-ai-cover.js";

export const IMAGES_PER_HOUR = 20;

/** Public address of an asset by id; the same shape the hosted service uses. */
export function assetUrl(assetId: string): string {
  return `${PUBLIC_ORIGIN}/cdn/${assetId}`;
}
export const TOOL_RUNS_PER_HOUR = 20;
export const TOOL_RETRY_WINDOW_MS = 10 * 60_000;

export const GENERATE_IMAGE: ToolDefinition = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Generate one picture and save it to the creator's assets. Not available in this edition.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
  },
};

export const RUN_MEDIA_TOOL = runMediaToolDefinition("outside", TOOL_RUNS_PER_HOUR);
export const LIST_MEDIA_TOOLS = LIST_MEDIA_TOOLS_DEFINITION;
export const GET_MEDIA_JOB = GET_MEDIA_JOB_DEFINITION;

type ToolOutcome = { ok: boolean; result?: unknown; error?: string };

export async function runGenerateImage(_args: { userId: string; worldId: string | null; input: Record<string, unknown> }): Promise<ToolOutcome> {
  return { ok: false, error: "Image generation is not available in this edition." };
}

export async function runMediaToolForOutsideAi(_args: { userId: string; worldId: string | null; input: Record<string, unknown> }): Promise<ToolOutcome> {
  return { ok: false, error: "Media tools are not available in this edition." };
}
