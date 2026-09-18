/** Cross-model retries are a user choice; they are separate from provider routing. */
export type ModelFallbackReason = "unavailable" | "policy" | "capacity";
export type ModelFallbackMode = "ask" | "auto" | "stop";

export interface ModelFallbackPolicy {
  mode: ModelFallbackMode;
  officialModel: string;
  privateModel: string;
  /** Authorization for a private model belongs to the selected API key. */
  privateKeyId: string | null;
}

export const DEFAULT_MODEL_FALLBACK_POLICY: ModelFallbackPolicy = {
  mode: "ask",
  officialModel: "google/gemini-2.5-flash-lite",
  privateModel: "",
  privateKeyId: null,
};

/** Stored on the resulting swipe so the explanation survives reloads. */
export interface ModelFallbackRecord {
  requestedModel: string;
  reason: ModelFallbackReason;
  automatic: boolean;
}

/** Serializable UI state. The retry callback stays in the parent application. */
export interface ModelFallbackNotice {
  id: string;
  sessionId: string;
  userMessageId?: string;
  requestedModel: string;
  failedModel: string;
  suggestedModel: string;
  reason: ModelFallbackReason;
  status: "ask" | "stopped" | "failed" | "switching";
  provider: "official" | "private";
}
