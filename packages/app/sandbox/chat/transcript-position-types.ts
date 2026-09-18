export interface TranscriptPosition {
  version: 1;
  sessionId: string;
  mode: "latest" | "reading";
  anchorId: string | null;
  offset: number;
  top: number;
  expanded: boolean;
  loadedCount: number;
}

export function isTranscriptPosition(value: unknown): value is TranscriptPosition {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<TranscriptPosition>;
  return p.version === 1 && typeof p.sessionId === "string" && p.sessionId.length <= 200 &&
    (p.mode === "latest" || p.mode === "reading") &&
    (p.anchorId === null || (typeof p.anchorId === "string" && p.anchorId.length <= 200)) &&
    typeof p.offset === "number" && Number.isFinite(p.offset) && Math.abs(p.offset) < 100_000_000 &&
    typeof p.top === "number" && Number.isFinite(p.top) && p.top >= 0 && p.top < 100_000_000 &&
    typeof p.expanded === "boolean" && typeof p.loadedCount === "number" &&
    Number.isInteger(p.loadedCount) && p.loadedCount >= 0 && p.loadedCount <= 100_000;
}
