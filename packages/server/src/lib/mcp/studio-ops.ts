/**
 * Open-source edition stub. The Studio MCP tools (image and video generation,
 * the voice market, library uploads from a URL) run on hosted providers and
 * are credit-metered, so the local build lists none of them. The MCP server
 * keeps the world tools and the studio view; a call that slips through fails
 * with a clear message instead of reaching a provider.
 */
import type { ToolDefinition } from "../llm/types.js";

export type StudioOpResult = { ok: boolean; result?: unknown; error?: string; view?: Record<string, unknown> };

export const CONFIRM_ABOVE_MUSHIES = 300;
export const VIDEOS_PER_HOUR = 10;

export const STUDIO_OPS: ToolDefinition[] = [];
export const STUDIO_OP_NAMES = new Set<string>();

export async function runStudioOp(_args: { userId: string; name: string; input: Record<string, unknown> }): Promise<StudioOpResult> {
  return { ok: false, error: "Studio media tools are not available in this edition." };
}
