import { isTranscriptPosition, type TranscriptPosition } from "../../sandbox/chat/transcript-position-types";

const KEY = "yumina:transcript-positions:v1";
type Entries = Record<string, TranscriptPosition>;
let memory: Entries = {};
function read(): Entries {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) memory = Object.fromEntries(
      Object.entries(value).filter(([, position]) => isTranscriptPosition(position)).slice(-32),
    );
  } catch { /* Storage may be unavailable; keep the in-memory copy. */ }
  return memory;
}
const key = (accountId: string, sessionId: string) => JSON.stringify([accountId, sessionId]);
export function loadTranscriptPosition(accountId: string, sessionId: string): TranscriptPosition | null {
  return read()[key(accountId, sessionId)] ?? null;
}
export function saveTranscriptPosition(accountId: string, position: TranscriptPosition): void {
  if (!isTranscriptPosition(position)) return;
  const entries = read();
  const id = key(accountId, position.sessionId);
  delete entries[id];
  entries[id] = position;
  memory = Object.fromEntries(Object.entries(entries).slice(-32));
  try { sessionStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* Best effort. */ }
}
