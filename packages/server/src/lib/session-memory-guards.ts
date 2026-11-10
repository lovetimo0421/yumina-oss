import { createHash } from "node:crypto";
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { messages, playSessions } from "../db/schema.js";

export const MEMORY_CLAIM_TTL_MS = 15 * 60 * 1000;

export type MemoryJobSnapshot = Pick<typeof playSessions.$inferSelect,
  "sessionMemorySourceHash" | "sessionMemoryProcessedMessageId" | "sessionMemoryUpdatedAt"
  | "sessionMemoryStaleAt" | "sessionMemoryModel" | "summaryLanguage" | "sessionMemoryIncluded"
>;

/** Settings preserve the memory text, so they must also preserve its CURRENT
 * committed cursor, even if a background job finished after the route read. */
export function memoryCursorAfterSettingsChange() {
  return sql<string | null>`CASE
    WHEN ${playSessions.sessionMemorySourceHash} LIKE 'repair:%'
      OR (${playSessions.sessionMemoryStatus} IN ('failed', 'updating')
        AND (${playSessions.sessionMemorySourceHash} IS NULL OR ${playSessions.sessionMemorySourceHash} NOT LIKE 'v2:%'))
    THEN NULL ELSE ${playSessions.sessionMemoryProcessedMessageId} END`;
}

/** Compare the input snapshot as well as the lease. A stale worker must not
 * claim work over an older memory after another worker saved or the user edited. */
export function memoryClaimGuard(snapshot: MemoryJobSnapshot, now: Date) {
  return and(
    snapshot.sessionMemorySourceHash === null ? isNull(playSessions.sessionMemorySourceHash) : eq(playSessions.sessionMemorySourceHash, snapshot.sessionMemorySourceHash),
    snapshot.sessionMemoryProcessedMessageId === null ? isNull(playSessions.sessionMemoryProcessedMessageId) : eq(playSessions.sessionMemoryProcessedMessageId, snapshot.sessionMemoryProcessedMessageId),
    snapshot.sessionMemoryUpdatedAt === null ? isNull(playSessions.sessionMemoryUpdatedAt) : eq(playSessions.sessionMemoryUpdatedAt, snapshot.sessionMemoryUpdatedAt),
    snapshot.sessionMemoryStaleAt === null ? isNull(playSessions.sessionMemoryStaleAt) : eq(playSessions.sessionMemoryStaleAt, snapshot.sessionMemoryStaleAt),
    snapshot.sessionMemoryModel === null ? isNull(playSessions.sessionMemoryModel) : eq(playSessions.sessionMemoryModel, snapshot.sessionMemoryModel),
    snapshot.summaryLanguage === null ? isNull(playSessions.summaryLanguage) : eq(playSessions.summaryLanguage, snapshot.summaryLanguage),
    eq(playSessions.sessionMemoryIncluded, snapshot.sessionMemoryIncluded),
    or(ne(playSessions.sessionMemoryStatus, "updating"), isNull(playSessions.sessionMemoryClaimedAt), lt(playSessions.sessionMemoryClaimedAt, new Date(now.getTime() - MEMORY_CLAIM_TTL_MS))),
  );
}

/** Keep timestamp comparisons in PostgreSQL: Date round-trips lose sub-ms
 * precision and can repeatedly select the cursor or exclude the final reply. */
export function pendingMemoryRange(sessionId: string, safeTipId: string, cursorId: string | null) {
  return and(
    eq(messages.sessionId, sessionId),
    eq(messages.status, "complete"),
    sql`${messages.role} IN ('user', 'assistant')`,
    sql`(${messages.createdAt}, ${messages.id}) <= (SELECT created_at, id FROM messages WHERE id = ${safeTipId} AND session_id = ${sessionId})`,
    cursorId ? sql`(${messages.createdAt}, ${messages.id}) > (SELECT created_at, id FROM messages WHERE id = ${cursorId} AND session_id = ${sessionId})` : undefined,
  );
}

/** The excluded newest reply must survive, but changing its text is harmless:
 * that reply was never evidence for this memory job. */
export function memoryLagGuard(sessionId: string, excludedReplyId: string | undefined) {
  return excludedReplyId
    ? sql`EXISTS (SELECT 1 FROM messages WHERE id = ${excludedReplyId} AND session_id = ${sessionId} AND role = 'assistant' AND status = 'complete')`
    : undefined;
}

/** Validate inside claim AND persist. Checking only the final ID misses a
 * deleted/edited middle message, especially before the first memory exists.
 * Completion filtering belongs to session memory; story and layered summaries
 * share this evidence guard but retain their own source-selection policy. */
export function memorySourceGuard(sessionId: string, rows: Array<{ id: string; content?: string; digest?: string; role?: string }>, options: { requireComplete?: boolean } = {}) {
  if (!rows.length) return undefined;
  const sources = rows.map(row => ({ id: row.id, role: row.role ?? null, digest: row.digest ?? createHash("md5").update(row.content ?? "").digest("hex") }));
  return sql`NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(sources)}::jsonb) AS source(id text, digest text, role text)
    LEFT JOIN messages m ON m.id = source.id AND m.session_id = ${sessionId}
    WHERE m.id IS NULL OR ${options.requireComplete ? sql`m.status IS DISTINCT FROM 'complete'` : sql`FALSE`} OR md5(m.content) <> source.digest OR (source.role IS NOT NULL AND m.role <> source.role)
  )`;
}


/** Only completed replies define the lag-one evidence boundary. */
export function memoryReplyFilter(sessionId: string) {
  return and(eq(messages.sessionId, sessionId), eq(messages.role, "assistant"), eq(messages.status, "complete"));
}

/** Counts the eligible interval, including rows that finished during generation. */
export function memorySourceCountGuard(sessionId: string, tipId: string | null, count: number, cursorId: string | null = null) {
  return sql`(SELECT count(*) FROM messages WHERE session_id = ${sessionId}
    AND status = 'complete' AND role IN ('user','assistant')
    AND ${cursorId ? sql`(created_at,id) > (SELECT created_at,id FROM messages WHERE id = ${cursorId} AND session_id = ${sessionId})` : sql`TRUE`}
    AND (created_at,id) <= (SELECT created_at,id FROM messages WHERE id = ${tipId} AND session_id = ${sessionId})) = ${count}`;
}

/** Old generated memories may contain failed turns. Explicit manual text has
 * no generated provenance, and a certified filtered rebuild needs no rescan. */
export function memoryRepairFilter(sessionId: string, cursorId: string | null, sourceHash: string | null) {
  if (!cursorId || !sourceHash || (sourceHash.includes(":eligible-v1") && !sourceHash.startsWith("repair:"))) return undefined;
  return and(eq(messages.sessionId, sessionId), ne(messages.status, "complete"),
    sql`${messages.role} IN ('user','assistant')`,
    sql`(${messages.createdAt}, ${messages.id}) <= (SELECT created_at,id FROM messages WHERE id = ${cursorId} AND session_id = ${sessionId})`);
}
