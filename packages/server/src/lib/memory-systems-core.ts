export type SessionMemorySystemRow = {
  sessionMemoryIncluded?: boolean | null;
  summaryIncluded?: boolean | null;
  summaryceptionIncluded?: boolean | null;
  summaryImplementation?: unknown;
};

export type MemorySystemSettings = {
  sessionMemoryIncluded: boolean;
  localdevSummaryIncluded: boolean;
  summaryceptionIncluded: boolean;
};

export type MessageCompactionFlags = {
  compacted?: boolean | null;
  summaryceptionCompacted?: boolean | null;
};

export function getMemorySystemSettings(row: SessionMemorySystemRow): MemorySystemSettings {
  const legacySummaryception = row.summaryImplementation === "summaryception";
  return {
    sessionMemoryIncluded: row.sessionMemoryIncluded ?? true,
    localdevSummaryIncluded: row.summaryIncluded ?? !legacySummaryception,
    summaryceptionIncluded: row.summaryceptionIncluded ?? legacySummaryception,
  };
}

export function shouldUseRawHistoryMessage(
  settings: Pick<MemorySystemSettings, "localdevSummaryIncluded" | "summaryceptionIncluded">,
  message: MessageCompactionFlags,
): boolean {
  if (settings.localdevSummaryIncluded && message.compacted === true) return false;
  if (settings.summaryceptionIncluded && message.summaryceptionCompacted === true) return false;
  return true;
}

