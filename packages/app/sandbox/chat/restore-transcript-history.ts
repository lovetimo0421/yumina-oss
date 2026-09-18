import type { TranscriptPosition } from "./transcript-position-types";
export interface HistoryRestoreState {
  sessionId: string;
  messages: readonly { id?: unknown }[];
  hasEarlierMessages: boolean;
  isLoadingEarlier: boolean;
}

/** The checkpoint bounds work to the history the reader previously loaded. */
export async function restoreTranscriptHistory(position: TranscriptPosition, signal: AbortSignal, options: {
  current: () => HistoryRestoreState;
  load: () => Promise<boolean>;
  committed: (previous: HistoryRestoreState) => Promise<void>;
}): Promise<void> {
  const budget = Math.ceil(position.loadedCount / 200) + 1;
  for (let page = 0; page < budget && !signal.aborted; page++) {
    const current = options.current();
    if (current.sessionId !== position.sessionId || current.messages.some((row) => row.id === position.anchorId) ||
        !current.hasEarlierMessages) return;
    if (current.isLoadingEarlier) { await options.committed(current); page--; continue; }
    if (!await options.load()) return;
    await options.committed(current);
  }
}
