import { DEFAULT_MODEL_FALLBACK_POLICY, type ModelFallbackPolicy, type ModelFallbackReason, type ModelFallbackRecord } from "@yumina/shared";

export interface ModelFallbackRetry {
  requestedModel: string;
  reason: ModelFallbackReason;
  automatic: boolean;
  attemptedFallback: boolean;
  userMessageId?: string;
}

export function fallbackRecord(retry: ModelFallbackRetry | undefined, model: string): ModelFallbackRecord | undefined {
  if (!retry || retry.requestedModel === model) return undefined;
  return { requestedModel: retry.requestedModel, reason: retry.reason, automatic: retry.automatic };
}

export function parseFallbackError(error: string) {
  try {
    const data = JSON.parse(error.replace(/^HTTP \d+: /, ""));
    const f = data?.fallback;
    if (data.code !== "MODEL_FALLBACK_REQUIRED" || !f ||
        typeof f.requestedModel !== "string" || !f.requestedModel ||
        !["unavailable", "policy", "capacity"].includes(f.reason) ||
        !["official", "private"].includes(f.provider)) return null;
    return {
      requestedModel: f.requestedModel as string,
      reason: f.reason as ModelFallbackReason,
      provider: f.provider as "official" | "private",
      userMessageId: typeof data.userMessageId === "string" ? data.userMessageId : undefined,
    };
  } catch { return null; }
}

export function fallbackDecision(
  policy: ModelFallbackPolicy | undefined,
  provider: "official" | "private",
  activeKeyId: string | null,
  failedModel: string,
  attemptedFallback: boolean,
) {
  const p = policy ?? DEFAULT_MODEL_FALLBACK_POLICY;
  const candidate = provider === "official" ? p.officialModel
    : activeKeyId && activeKeyId === p.privateKeyId ? p.privateModel : "";
  const suggestedModel = candidate && candidate !== failedModel ? candidate : "";
  return {
    suggestedModel,
    autoRetry: p.mode === "auto" && !!suggestedModel && !attemptedFallback,
    status: attemptedFallback ? "failed" as const : p.mode === "stop" ? "stopped" as const : "ask" as const,
  };
}
