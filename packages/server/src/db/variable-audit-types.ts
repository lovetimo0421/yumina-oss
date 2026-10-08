/** JSON storage contract only. Keep this free of service-layer imports so
 * database consumers do not inherit the chat runtime's dependency graph. */
export type AuditValue = { value: unknown; truncated?: true; originalChars?: number };

type AuditSource = {
  kind: "setup" | "ai" | "judge" | "rule" | "settle";
  ids?: string[];
  via?: "repair" | "guard" | "formula";
};

type JudgeVerdict = {
  chosen: string | number | boolean | null;
  confidence: number;
  proposed: boolean;
  applied: boolean;
  reason?: string;
};

export interface VariableAuditSegment {
  version: 1;
  path: "send" | "regenerate" | "continue";
  at: string;
  turnCount: number;
  changes: Array<{ variableId: string; oldValue: AuditValue; newValue: AuditValue; source: AuditSource | null }>;
  /** Actual committed values, after concurrent-state reconciliation. */
  committed: Array<{ variableId: string; value: AuditValue }>;
  judge: {
    ran: boolean;
    audit?: { status: "disabled" | "no-questions" | "completed" | "error"; model?: string; errorCode?: string; ms?: number };
    decisions: Array<JudgeVerdict & { variableId: string }>;
    asked: Array<JudgeVerdict & {
      key: string;
      kind: "number" | "boolean" | "string" | "bgm" | "sfx" | "image";
      question: string;
      options: string[];
    }>;
  };
  repair: {
    ran: boolean;
    audit?: {
      status: "disabled" | "guard-handled" | "empty-reply" | "no-candidates" | "no-missing" | "repaired" | "no-usable-effects" | "error";
      checked: Record<string, number | null>;
      stage?: "judge" | "repair";
      model?: string;
      repairModel?: string;
      repairMs?: number;
      errorCode?: string;
      ms?: number;
    };
    flagged: Record<string, number>;
    proposed: string[];
    applied: string[];
  };
  dropped: Array<{ variableId: string; reason: "internal" | "read-only" | "inactive" | "judge" }>;
  rejected: string[];
  blocked: Array<{ variableId: string; reason: string; attemptedValue: AuditValue; phase: "ai" | "rule" }>;
  /** Partial evidence is never presented as complete. */
  omitted: { changes: number; committed: number; decisions: number; asked: number; dropped: number; rejected: number; blocked: number; repairDetails?: true };
}

export interface StoredVariableAudit {
  version: 1;
  segments: VariableAuditSegment[];
  omittedSegments: number;
}
