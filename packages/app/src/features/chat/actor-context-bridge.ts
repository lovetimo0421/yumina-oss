import type { ActorContextRequest, ActorContextResult } from "../../../sandbox/actor-context-types";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function isRequest(value: unknown): value is ActorContextRequest {
  if (!record(value) || Object.keys(value).some(key => !["actor", "model", "recentMessages"].includes(key))) return false;
  if (value.actor !== "voice" && value.actor !== "director") return false;
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim() || value.model.length > 200)) return false;
  if (value.recentMessages === undefined) return true;
  return Array.isArray(value.recentMessages) && value.recentMessages.length <= 24 && value.recentMessages.every(message =>
    record(message) && Object.keys(message).length === 2 && (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.length <= 4_000,
  ) && value.recentMessages.reduce((total, message) => total + message.content.length, 0) <= 12_000;
}

/** Authenticated session forwarding; errors resolve so the generic bridge cannot hang. */
export async function dispatchActorContextCall(args: unknown[], options: {
  sessionId: string;
  available: boolean;
  currentSessionId(): string;
  fetch: typeof fetch;
  apiBase?: string;
}): Promise<ActorContextResult | { error: string }> {
  if (!options.available || !options.sessionId) return { error: "Actor context is unavailable in this view." };
  if (!Array.isArray(args) || args.length !== 1 || !isRequest(args[0])) return { error: "Invalid actor context request." };
  const current = () => options.currentSessionId() === options.sessionId;
  if (!current()) return { error: "The session changed." };
  try {
    const response = await options.fetch(`${options.apiBase ?? ""}/api/sessions/${encodeURIComponent(options.sessionId)}/actor-context`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args[0]), signal: AbortSignal.timeout(20_000),
    });
    const raw: unknown = await response.json();
    if (!current()) return { error: "The session changed." };
    if (!response.ok) return { error: record(raw) && typeof raw.error === "string" ? raw.error : "Actor context could not be loaded." };
    const result = record(raw) && record(raw.data) ? raw.data : raw;
    if (!record(result) || typeof result.instructions !== "string" || result.instructions.length > 12_000 || !record(result.receipt)) return { error: "Actor context returned an invalid response." };
    return result as unknown as ActorContextResult;
  } catch {
    return { error: "Actor context could not be loaded. Try again." };
  }
}
