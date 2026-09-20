export interface StateGuardSettings {
  enabled: boolean;
  /** null uses the default correction model; official:: / private:: tags are guard-only. */
  model: string | null;
  /** Server-reported capability; omitted by older/hosted servers. Not a setting. */
  officialModels?: boolean;
}

export interface StateValidationAudit {
  version: 1;
  attemptId: string;
  targetMessageId?: string;
  path: "send" | "regenerate" | "continue";
  outcome: "validating" | "repairing" | "valid-updates" | "explicit-none" | "not-required" | "failed" | "cancelled" | "stale";
  initialOutcome?: string;
  diagnostics: string[];
  declaredCount?: number;
  parsedCount: number;
  appliedCount?: number;
  repaired: boolean;
  correctionCount: number;
  /** Kept separately from original rawContent; never fed into story memory. */
  correctedBatch?: string;
  /** Bounded pre-correction response for owner diagnostics, never LLM history/analytics. */
  originalRaw?: string;
  originalRawTruncated?: boolean;
  /** Display names at the time of this check. Older records may use current card names. */
  variableNames?: Record<string, string>;
  model: string;
  apiKeyTier: string;
  correctionModel?: string;
  correctionApiKeyTier?: string;
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  baselineFingerprint: string;
  usageLogIds: string[];
  /** Engine-produced AI/rule deltas for this attempt only; large values may be previews. */
  changes?: Array<{ variableId: string; oldValue: unknown; newValue: unknown; source: "ai" | "rule"; truncated?: boolean }>;
  changesTruncated?: boolean;
  /** True only inside the successful state/message transaction. */
  committed?: boolean;
}
