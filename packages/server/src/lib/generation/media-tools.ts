/**
 * Open-source edition stub. The media tools (video, music, voice design and
 * the rest) run on hosted providers and are credit-metered. Here they are
 * never enabled, so the Studio assistant and the MCP server leave them out
 * of the tool list, and a call that slips through fails with a clear code.
 * The pure helpers keep their real behaviour so callers need no edition check.
 */

export const MEDIA_TOOL_PROVIDER = "fal-tool";
export const TOOL_JOB_TIMEOUT_MS = 45 * 60 * 1000;

export type ToolValues = Record<string, string | number | boolean>;

export class MediaToolError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 500, message?: string) {
    super(message ?? code);
    this.name = "MediaToolError";
    this.code = code;
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assetIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().replace(/^@asset:/, "");
  return UUID.test(id) ? id.toLowerCase() : null;
}

export function falKey(): string | undefined {
  return undefined;
}

export function mediaToolAvailable(_toolId: string): boolean {
  return false;
}

export function mediaToolsEnabled(): boolean {
  return false;
}

export function ttsLineOf(_value: unknown): string | null {
  return null;
}

export function validateToolInputs(_tool: unknown, _raw: unknown, _opts: { partial?: boolean } = {}): ToolValues {
  throw new MediaToolError("MEDIA_TOOLS_UNAVAILABLE", 503, "Media tools are not available in this edition");
}

export async function withTranscodeSlot<T>(_userId: string, fn: () => Promise<T>): Promise<T> {
  return fn();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function estimateMediaTool(..._args: unknown[]): Promise<any> {
  throw new MediaToolError("MEDIA_TOOLS_UNAVAILABLE", 503, "Media tools are not available in this edition");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function submitMediaTool(..._args: unknown[]): Promise<any> {
  throw new MediaToolError("MEDIA_TOOLS_UNAVAILABLE", 503, "Media tools are not available in this edition");
}
