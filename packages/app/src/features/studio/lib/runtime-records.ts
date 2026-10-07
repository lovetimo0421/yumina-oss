import type { GameState } from "@yumina/engine";

export interface RuntimeChange { variableId: string; oldValue: unknown; newValue: unknown }
export type ChangeSourceKind = "setup" | "ai" | "judge" | "rule" | "settle";
/** Mirrors the server's ChangeTrace (packages/server/src/lib/change-trace.ts). */
export interface RuntimeTrace {
  sources: Array<{ kind: ChangeSourceKind; ids?: string[] }>;
  dropped: Array<{ variableId: string; reason: "internal" | "read-only" | "inactive" | "judge" }>;
  rejected: string[];
  aiWrote: string[];
  judge: Array<{ variableId: string; chosen: string | number | boolean | null; confidence: number; applied: boolean; reason?: string }>;
  /** Every question the continuity judge (Jev) was asked, with its answer. */
  asked?: Array<{ key: string; kind: "number" | "boolean" | "string" | "bgm" | "sfx" | "image"; question: string; options: string[]; chosen: string | number | boolean | null; confidence: number; applied: boolean; reason?: string }>;
}
export type PromptSegmentKind = "lore" | "persona" | "platform" | "examples" | "lore-triggered" | "memory" | "inputs" | "history" | "pending" | "state" | "scene" | "post";
/** Mirrors the server's PromptTrace (packages/server/src/lib/prompt-trace.ts):
 *  what the AI was actually sent this turn, measured after trimming. */
export interface RuntimePromptTrace {
  speaker: { id: string; name: string } | null;
  model: string;
  totalChars: number;
  segments: Array<{ kind: PromptSegmentKind; chars: number; messages: number }>;
  historyMessages: number;
}
export type RuntimeRecordKind = "turn" | "regenerate" | "continue" | "action" | "restore" | "quiet";
export interface RuntimeRecord {
  id: string;
  sessionId: string;
  kind: RuntimeRecordKind;
  at: string;
  turnCount: number | null;
  actionId?: string;
  messageId?: string;
  /** null means the server did not report this, not that nothing fired. */
  firedIds: string[] | null;
  /** Lore that actually reached the model this turn. Null on an older server;
   *  an empty array genuinely means none. The distinction matters — the
   *  canvas dims what was not used, and dimming everything because the server
   *  said nothing would be a lie about the card. */
  injectedEntryIds: string[] | null;
  changes: RuntimeChange[];
  /** Who wrote what. Null on an older server — then nothing is attributed. */
  trace: RuntimeTrace | null;
  /** Which quiet station woke this record (kind "quiet"). */
  quietSpeaker?: { id: string; name: string };
  /** The speaker answered the player after another AI of the room, rather
   *  than speaking up in a silence. */
  group?: true;
  /** Events the AI set off this turn with `[event: name]`. */
  storyEvents: string[];
  /** What the AI received. Null on an older server or a button press. */
  prompt: RuntimePromptTrace | null;
  /** The state check replaced the AI's own writes with a corrected batch. */
  repaired: boolean;
  /** State after this result, for reading rule progress at that moment. */
  state: GameState | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only capture real server outcomes for the explicitly selected playtest.
 * No snapshots are compared to guess causes; old servers remain "not reported". */
export function appendRuntimeRecord(
  rows: RuntimeRecord[],
  recordingSessionId: string | null,
  sessionId: string,
  kind: RuntimeRecordKind,
  payload: Record<string, unknown>,
  actionId?: string,
): RuntimeRecord[] {
  if (recordingSessionId !== sessionId) return rows;
  const rawChanges = payload.stateChanges ?? payload.changes;
  const changes: RuntimeChange[] = Array.isArray(rawChanges)
    ? rawChanges.filter((item): item is RuntimeChange => record(item) && typeof item.variableId === "string" && "oldValue" in item && "newValue" in item)
    : [];
  const snapshot = record(payload.state) ? payload.state : null;
  const next: RuntimeRecord = {
    id: crypto.randomUUID(), sessionId, kind, at: new Date().toISOString(),
    turnCount: typeof snapshot?.turnCount === "number" ? snapshot.turnCount : null,
    ...(actionId ? { actionId } : {}),
    ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
    ...(kind === "quiet" && record(payload.speaker) && typeof payload.speaker.id === "string" && typeof payload.speaker.name === "string"
      ? { quietSpeaker: { id: payload.speaker.id, name: payload.speaker.name } } : {}),
    ...(payload.group === true ? { group: true as const } : {}),
    firedIds: Array.isArray(payload.firedIds) ? [...new Set(payload.firedIds.filter((id): id is string => typeof id === "string"))] : null,
    injectedEntryIds: Array.isArray(payload.injectedEntryIds)
      ? [...new Set(payload.injectedEntryIds.filter((id): id is string => typeof id === "string"))]
      : null,
    changes,
    trace: parseTrace(payload.changeTrace),
    prompt: parsePrompt(payload.promptTrace),
    storyEvents: strings(payload.storyEvents),
    repaired: record(payload.stateValidation) && payload.stateValidation.repaired === true,
    state: snapshot as GameState | null,
  };
  return [...rows, next].slice(-40);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function parseTrace(raw: unknown): RuntimeTrace | null {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.sources)) return null;
  return {
    sources: raw.sources.map((item) => record(item) && typeof item.kind === "string"
      ? { kind: item.kind as ChangeSourceKind, ...(Array.isArray(item.ids) ? { ids: strings(item.ids) } : {}) }
      : { kind: "ai" as const }),
    dropped: Array.isArray(raw.dropped)
      ? raw.dropped.filter((item): item is RuntimeTrace["dropped"][number] => record(item) && typeof item.variableId === "string" && typeof item.reason === "string")
      : [],
    rejected: strings(raw.rejected),
    aiWrote: strings(raw.aiWrote),
    asked: Array.isArray(raw.asked)
      ? raw.asked.filter((item): item is NonNullable<RuntimeTrace["asked"]>[number] => record(item) && typeof item.key === "string" && typeof item.kind === "string" && typeof item.confidence === "number")
        .map((item) => ({ ...item, question: typeof item.question === "string" ? item.question : "", options: strings(item.options) }))
      : [],
    judge: Array.isArray(raw.judge)
      ? raw.judge.filter((item): item is RuntimeTrace["judge"][number] => record(item) && typeof item.variableId === "string" && typeof item.confidence === "number")
      : [],
  };
}

const SEGMENTS = new Set<PromptSegmentKind>(["lore", "persona", "platform", "examples", "lore-triggered", "memory", "inputs", "history", "pending", "state", "scene", "post"]);
function parsePrompt(raw: unknown): RuntimePromptTrace | null {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.segments) || typeof raw.totalChars !== "number") return null;
  const speaker = record(raw.speaker) && typeof raw.speaker.id === "string" && typeof raw.speaker.name === "string"
    ? { id: raw.speaker.id, name: raw.speaker.name } : null;
  return {
    speaker,
    model: typeof raw.model === "string" ? raw.model : "",
    totalChars: raw.totalChars,
    segments: raw.segments.filter((item): item is RuntimePromptTrace["segments"][number] =>
      record(item) && SEGMENTS.has(item.kind as PromptSegmentKind) && typeof item.chars === "number" && typeof item.messages === "number"),
    historyMessages: typeof raw.historyMessages === "number" ? raw.historyMessages : 0,
  };
}
