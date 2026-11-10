import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions } from "../db/schema.js";

type Session = typeof playSessions.$inferSelect;
/** Compare only generation inputs; an appended chat turn is not invalidation. */
export function continuitySnapshotGuard(snapshot: Session, fields: Array<keyof Session>) {
  return and(...fields.map(key => {
    const value = snapshot[key];
    return value !== null && typeof value === "object" && !(value instanceof Date)
      ? sql`${playSessions[key]} IS NOT DISTINCT FROM ${JSON.stringify(value)}::jsonb`
      : sql`${playSessions[key]} IS NOT DISTINCT FROM ${value}`;
  }));
}

export const STORY_INPUT_FIELDS: Array<keyof Session> = [
  "summary", "summarySourceHash", "summaryUpdatedAt", "summaryCoversUntilMessageId",
  "summaryModel", "summaryLanguage", "summaryIncluded", "summaryRecentTailTokens", "summaryTriggerTokens",
];
export const LAYERED_INPUT_FIELDS: Array<keyof Session> = [
  "summaryceptionSourceHash", "summaryceptionModel", "summaryceptionIncluded",
  "summaryLanguage", "summaryRecentTailTokens", "summaryMode", "summaryIncluded", "summaryModel",
];

export type HistoricalState = { id: string; snapshot: unknown };
export async function loadHistoricalState(sessionId: string, id: string): Promise<HistoricalState> {
  const [row] = await db.select({ snapshot: messages.stateSnapshot }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.id, id)));
  if (!row) throw new Error("Summary source changed; retry with the current conversation");
  return { id, snapshot: row.snapshot };
}

export function historicalStateGuard(sessionId: string, sources: HistoricalState[] = []) {
  return and(...sources.map(source => sql`EXISTS (SELECT 1 FROM messages
    WHERE id = ${source.id} AND session_id = ${sessionId}
      AND ${source.snapshot == null ? sql`state_snapshot IS NULL` : sql`state_snapshot IS NOT DISTINCT FROM ${JSON.stringify(source.snapshot)}::jsonb`})`));
}

/** A previous derived record is eligible only if its proven endpoint precedes
 * this passage. Unknown/deleted/future endpoints require a raw-history repair. */
export async function assertPriorCoverage(sessionId: string, endpoints: Array<string | null>, beforeId: string) {
  if (!endpoints.length) return;
  if (endpoints.some(id => !id)) throw new Error("Earlier summary coverage is unknown. Repair from original messages before compacting.");
  for (const id of new Set(endpoints)) {
    const [valid] = await db.select({ id: messages.id }).from(messages).where(and(
      eq(messages.sessionId, sessionId), eq(messages.id, id!),
      sql`(${messages.createdAt}, ${messages.id}) < (SELECT created_at, id FROM messages WHERE id = ${beforeId} AND session_id = ${sessionId})`,
    ));
    if (!valid) throw new Error("Earlier summary crosses this passage or its source was removed. Repair from original messages before compacting.");
  }
}
