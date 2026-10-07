export type PlaytestIssue = "model" | "provider" | "credits" | "promptCost" | "modelAccess" | "busy" | "tooLong" | "access" | "connection" | "request";

export function resolvePlaytestIssue(input: {
  sessionId: string;
  activeSessionId?: string;
  streaming: boolean;
  hasModel: boolean;
  privateCatalogEmpty: boolean;
  failure: { sessionId: string; code: string; balance?: number } | null;
  error: string | null;
}): PlaytestIssue | null {
  if (input.activeSessionId !== input.sessionId || input.streaming) return null;
  const failure = input.failure?.sessionId === input.sessionId ? input.failure : null;
  switch (failure?.code) {
    case "NO_CREDITS": return (failure.balance ?? 0) > 0 ? "promptCost" : "credits";
    case "MODEL_NOT_ALLOWED": return "modelAccess";
    case "RATE_LIMITED": case "CONCURRENT_LIMIT": return "busy";
    case "MESSAGE_TOO_LONG": return "tooLong";
    case "SUSPENDED": case "PROTECTED_WORLD": return "access";
    case "CONNECTION_UNCERTAIN": return "connection";
  }
  if (input.privateCatalogEmpty) return "provider";
  if (!input.hasModel) return "model";
  if (failure || (input.error && !input.failure)) return "request";
  return null;
}
