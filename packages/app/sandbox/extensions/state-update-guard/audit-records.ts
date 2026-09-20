import type { StateValidationAudit } from "@yumina/shared";

/** Enrich only the owner-facing copy. Never reconstruct an old value or mix attempts. */
export function displayAudit(audit: StateValidationAudit, raw?: unknown, defs?: ReadonlyArray<{ id: string; name?: string }>): StateValidationAudit {
  const original = audit.originalRaw ?? (audit.path !== "continue" && typeof raw === "string" ? raw : undefined);
  return { ...audit,
    variableNames: { ...Object.fromEntries((defs ?? []).map((v) => [v.id, v.name ?? v.id])), ...audit.variableNames },
    ...(original !== undefined ? { originalRaw: original.slice(0, 65536), originalRawTruncated: audit.originalRawTruncated || original.length > 65536 } : {}),
  };
}

export function validationRecords(messages: Array<Record<string, unknown>>, defs?: ReadonlyArray<{ id: string; name?: string }>): StateValidationAudit[] {
  const seen = new Map<string, StateValidationAudit>();
  for (const message of messages) {
    if (Array.isArray(message.swipes)) for (const swipe of message.swipes) {
      const audit = swipe?.stateValidation as StateValidationAudit | undefined;
      if (audit?.version === 1) seen.set(audit.attemptId, displayAudit(audit, swipe.rawContent, defs));
    }
    const audit = message.stateValidation as StateValidationAudit | undefined;
    if (audit?.version === 1) {
      const previous = seen.get(audit.attemptId);
      seen.set(audit.attemptId, displayAudit({ ...previous, ...audit }, undefined, defs));
    }
  }
  return [...seen.values()];
}
