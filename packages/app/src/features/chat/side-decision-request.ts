import { aiDecisionRequestSchema, MAX_DECISION_REQUEST_CHARS, parseAiDecisionResponse, type AiDecisionResponse } from "@yumina/shared";

/** Host-only transport: the card cannot supply a key, model or account settings.
 * The selected narrative model is used by the server solely for BYOK policy. */
export async function requestSideDecision(sessionId: string, params: unknown, narrativeModel: string, signal: AbortSignal): Promise<AiDecisionResponse> {
  if (signal.aborted) throw new Error("Decision cancelled");
  const candidate = params as { state?: unknown; questions?: unknown } | null;
  const parsed = aiDecisionRequestSchema.safeParse({ state: candidate?.state, questions: candidate?.questions });
  if (!parsed.success) throw new Error("Invalid decision request");
  const body = JSON.stringify({ ...parsed.data, narrativeModel });
  if (body.length > MAX_DECISION_REQUEST_CHARS) throw new Error("Decision request budget exceeded");
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/decisions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body, signal,
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = result as { error?: unknown } | null;
    throw new Error(typeof error?.error === "string" ? error.error : `Decision failed (HTTP ${response.status})`);
  }
  if (signal.aborted) throw new Error("Decision cancelled");
  const validated = parseAiDecisionResponse(result, parsed.data.questions);
  if (!validated) throw new Error("Decision provider returned invalid answers");
  return validated;
}
