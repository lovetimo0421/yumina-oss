import type { GameState } from "@yumina/engine";
import type { ChangeTrace } from "./change-trace.js";
import type { ContinuityTurnOutcome } from "./continuity/run.js";
import type { MissedUpdateOutcome } from "./continuity/missed-updates.js";
import type { AuditValue, StoredVariableAudit, VariableAuditSegment } from "../db/variable-audit-types.js";
export type { StoredVariableAudit, VariableAuditSegment } from "../db/variable-audit-types.js";

type Change = { variableId: string; oldValue: unknown; newValue: unknown };
export type BlockedVariableWrite = { variableId: string; reason: string; attemptedValue: unknown; phase: "ai" | "rule" };

const MAX_ITEMS = 128;
const MAX_SEGMENT_BYTES = 64 * 1024;
const MAX_SEGMENTS = 8;

function valueForAudit(value: unknown): AuditValue {
  if (typeof value === "string" && value.length > 512) return { value: value.slice(0, 512), truncated: true, originalChars: value.length };
  const encoded = JSON.stringify(value) ?? "null";
  return encoded.length > 512
    ? { value: encoded.slice(0, 512), truncated: true, originalChars: encoded.length }
    : { value: JSON.parse(encoded) };
}

/** Stored on the exact swipe, inside the same transaction as its state.
 * Segments distinguish a continuation from the reply it extends. No raw
 * player text, narrative, prompt or provider error is copied into this log. */
export function buildVariableAudit(args: {
  path: VariableAuditSegment["path"];
  state: Pick<GameState, "variables" | "turnCount">;
  changes: Change[];
  trace: ChangeTrace;
  continuity: Pick<ContinuityTurnOutcome, "ran" | "audit">;
  repair: MissedUpdateOutcome;
  blocked?: BlockedVariableWrite[];
  at?: string;
}): VariableAuditSegment {
  const { trace } = args;
  const values = new WeakMap<object, AuditValue>();
  const snapshotValue = (value: unknown): AuditValue => {
    if (value === null || typeof value !== "object") return valueForAudit(value);
    const cached = values.get(value);
    if (cached) return cached;
    const result = valueForAudit(value);
    values.set(value, result);
    return result;
  };
  const appliedJudge = new Set(args.changes.filter((_, i) => trace.sources[i]?.kind === "judge").map(c => c.variableId));
  const appliedRepair = [...new Set(args.changes.filter((_, i) => trace.sources[i]?.via === "repair").map(c => c.variableId))];
  const roots = [...new Set([...args.changes.map(c => c.variableId), ...trace.judge.map(d => d.variableId), ...Object.keys(args.repair.flagged)])];
  const asked = trace.asked.filter(q => q.key.startsWith("var__"));
  const blocked = args.blocked ?? [];
  const segment: VariableAuditSegment = {
    version: 1, path: args.path, at: args.at ?? new Date().toISOString(), turnCount: args.state.turnCount,
    changes: args.changes.slice(0, MAX_ITEMS).map((c, i) => ({
      variableId: c.variableId, oldValue: snapshotValue(c.oldValue), newValue: snapshotValue(c.newValue),
      source: trace.sources[i] ?? null,
    })),
    committed: roots.slice(0, MAX_ITEMS).map(variableId => ({ variableId, value: snapshotValue(args.state.variables[variableId]) })),
    judge: {
      ran: args.continuity.ran, audit: args.continuity.audit,
      decisions: trace.judge.slice(0, MAX_ITEMS).map(d => ({ ...d, proposed: d.applied, applied: appliedJudge.has(d.variableId) })),
      asked: asked.slice(0, MAX_ITEMS).map(q => ({
        ...q, proposed: q.applied, applied: appliedJudge.has(q.key.slice("var__".length)),
      })),
    },
    repair: {
      ran: args.repair.ran, audit: args.repair.audit, flagged: args.repair.flagged,
      proposed: args.repair.effects.map(e => e.variableId), applied: appliedRepair,
    },
    dropped: trace.dropped.slice(0, MAX_ITEMS), rejected: trace.rejected.slice(0, MAX_ITEMS),
    blocked: blocked.slice(0, MAX_ITEMS).map(b => ({ ...b, attemptedValue: valueForAudit(b.attemptedValue) })),
    omitted: {
      changes: Math.max(0, args.changes.length - MAX_ITEMS), committed: Math.max(0, roots.length - MAX_ITEMS),
      decisions: Math.max(0, trace.judge.length - MAX_ITEMS), asked: Math.max(0, asked.length - MAX_ITEMS),
      dropped: Math.max(0, trace.dropped.length - MAX_ITEMS), rejected: Math.max(0, trace.rejected.length - MAX_ITEMS),
      blocked: Math.max(0, blocked.length - MAX_ITEMS),
    },
  };
  // Large JSON states must not turn audit storage into another full snapshot.
  // Trim the largest lists, retaining counts and decisions wherever possible.
  while (Buffer.byteLength(JSON.stringify(segment)) > MAX_SEGMENT_BYTES) {
    if (segment.judge.asked.length) { segment.judge.asked.pop(); segment.omitted.asked++; }
    else if (segment.changes.length) { segment.changes.pop(); segment.omitted.changes++; }
    else if (segment.committed.length) { segment.committed.pop(); segment.omitted.committed++; }
    else if (segment.blocked.length) { segment.blocked.pop(); segment.omitted.blocked++; }
    else if (segment.judge.decisions.length) { segment.judge.decisions.pop(); segment.omitted.decisions++; }
    else if (segment.dropped.length) { segment.dropped.pop(); segment.omitted.dropped++; }
    else if (segment.rejected.length) { segment.rejected.pop(); segment.omitted.rejected++; }
    else break;
  }
  // Imported cards may even use enormous IDs. Keep status/count evidence
  // instead of letting one malformed definition bypass the storage budget.
  if (Buffer.byteLength(JSON.stringify(segment)) > MAX_SEGMENT_BYTES) {
    segment.repair = { ran: args.repair.ran,
      audit: args.repair.audit ? { status: args.repair.audit.status, stage: args.repair.audit.stage, checked: {} } : undefined,
      flagged: {}, proposed: [], applied: [] };
    segment.judge.audit = args.continuity.audit ? { status: args.continuity.audit.status } : undefined;
    segment.omitted.repairDetails = true;
  }
  // A fresh JSON value prevents later state/trace mutation rewriting evidence.
  return JSON.parse(JSON.stringify(segment)) as VariableAuditSegment;
}

export function appendVariableAudit(previous: StoredVariableAudit | undefined, next: VariableAuditSegment): StoredVariableAudit {
  const old = previous?.version === 1 ? previous.segments : [];
  const segments = [...old, next];
  return {
    version: 1, segments: segments.slice(-MAX_SEGMENTS),
    omittedSegments: (previous?.omittedSegments ?? 0) + Math.max(0, segments.length - MAX_SEGMENTS),
  };
}
