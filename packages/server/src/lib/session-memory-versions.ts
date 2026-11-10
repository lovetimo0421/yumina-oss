// Saved versions of a session's structured memory, one per committed fold.
//
// Memory is a running fold: each update reads the memory so far plus the next
// turns. When an older turn changes, the memory may describe text that no
// longer exists, and the only repair used to be a full rebuild from the first
// message: ~20 calls and a few hundred mushies on a long chat, restarted from
// message one whenever it stopped (one player, 46 rebuilds and 6,506 mushies
// in a week, 2026-10-20). Edits land near the end of a chat (53 of 53 sampled
// edits were within the last 20 messages), so a rebuild can instead continue
// from the last version saved before the change, and a rebuild that stopped
// continues from the last batch it saved.
//
// A version is valid while every eligible turn up to its pointer is unchanged.
// Changes drop the versions they reach (dropMemoryVersionsFrom), a deleted
// pointer takes its versions with it (foreign key), and a fingerprint of the
// covered turns, ids and lengths, is checked again before a version is used.

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { SessionMemory } from "@yumina/shared";
import { db } from "../db/index.js";
import { sessionMemoryVersions } from "../db/schema.js";

type Database = Pick<typeof db, "execute" | "select" | "delete" | "insert">;

/** The table ships by hand before the code (scripts/session-memory-versions.sql).
 *  Until it exists, versions are simply absent: nothing else may break. */
function tableMissing(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  return e?.code === "42P01" || e?.cause?.code === "42P01" || /session_memory_versions.*does not exist/.test(e?.message ?? "");
}

async function unlessTableMissing<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (tableMissing(err)) return fallback;
    throw err;
  }
}

/** Enough to reach back past the edits players make (all sampled within the
 *  last 20 messages) at one version per ~15,000 characters of chat. */
export const MEMORY_VERSIONS_KEPT = 30;

/** The covered turns as a fold sees them: completed user and assistant rows up
 *  to and including the pointer, by id and length. */
function evidenceFingerprintSql(sessionId: string, pointerId: string) {
  return sql<string>`(SELECT md5(coalesce(string_agg(m.id || ':' || coalesce(m.content_len, length(m.content)), ',' ORDER BY m.created_at, m.id), ''))
    FROM messages m
    WHERE m.session_id = ${sessionId} AND m.status = 'complete' AND m.role IN ('user', 'assistant')
      AND (m.created_at, m.id) <= (SELECT created_at, id FROM messages WHERE id = ${pointerId} AND session_id = ${sessionId}))`;
}

/** Save the memory a fold committed through `processedMessageId`, inside the
 *  caller's transaction, and keep only the newest versions. */
export async function saveMemoryVersion(database: Database, args: {
  sessionId: string;
  processedMessageId: string;
  memory: SessionMemory;
}): Promise<void> {
  await database.execute(sql`INSERT INTO session_memory_versions (id, session_id, processed_message_id, processed_at, memory, source_fingerprint)
    SELECT ${crypto.randomUUID()}, ${args.sessionId}, m.id, m.created_at, ${JSON.stringify(args.memory)}::jsonb,
      ${evidenceFingerprintSql(args.sessionId, args.processedMessageId)}
    FROM messages m WHERE m.id = ${args.processedMessageId} AND m.session_id = ${args.sessionId}`);
  await database.execute(sql`DELETE FROM session_memory_versions WHERE session_id = ${args.sessionId} AND id NOT IN (
    SELECT id FROM session_memory_versions WHERE session_id = ${args.sessionId}
    ORDER BY processed_at DESC, created_at DESC LIMIT ${MEMORY_VERSIONS_KEPT})`);
}

/** The newest still-valid version at or before `tipId`. Versions whose turns
 *  changed underneath them are dropped on the way. */
export function latestValidMemoryVersion(sessionId: string, tipId: string): Promise<{
  processedMessageId: string;
  memory: SessionMemory;
} | null> {
  return unlessTableMissing(() => findLatestValidMemoryVersion(sessionId, tipId), null);
}

async function findLatestValidMemoryVersion(sessionId: string, tipId: string): Promise<{
  processedMessageId: string;
  memory: SessionMemory;
} | null> {
  const candidates = await db
    .select({
      id: sessionMemoryVersions.id,
      processedMessageId: sessionMemoryVersions.processedMessageId,
      memory: sessionMemoryVersions.memory,
      fingerprint: sessionMemoryVersions.sourceFingerprint,
    })
    .from(sessionMemoryVersions)
    .where(and(
      eq(sessionMemoryVersions.sessionId, sessionId),
      lte(sessionMemoryVersions.processedAt, sql`(SELECT created_at FROM messages WHERE id = ${tipId} AND session_id = ${sessionId})`),
    ))
    .orderBy(desc(sessionMemoryVersions.processedAt), desc(sessionMemoryVersions.createdAt))
    .limit(MEMORY_VERSIONS_KEPT);
  const stale: string[] = [];
  let found: { processedMessageId: string; memory: SessionMemory } | null = null;
  for (const candidate of candidates) {
    const result = await db.execute(sql`SELECT ${evidenceFingerprintSql(sessionId, candidate.processedMessageId)} AS fingerprint`);
    const rows = (result as unknown as { rows?: Array<{ fingerprint: string | null }> }).rows ?? (result as unknown as Array<{ fingerprint: string | null }>);
    if (rows[0]?.fingerprint === candidate.fingerprint) {
      found = { processedMessageId: candidate.processedMessageId, memory: candidate.memory as SessionMemory };
      break;
    }
    stale.push(candidate.id);
  }
  if (stale.length) await db.delete(sessionMemoryVersions).where(inArray(sessionMemoryVersions.id, stale));
  return found;
}

/** A turn changed: versions covering it no longer describe the chat. */
export async function dropMemoryVersionsFrom(sessionId: string, changedAt: Date | string | null | undefined): Promise<void> {
  await unlessTableMissing(async () => {
    await db.delete(sessionMemoryVersions).where(and(
      eq(sessionMemoryVersions.sessionId, sessionId),
      changedAt ? gte(sessionMemoryVersions.processedAt, new Date(changedAt)) : undefined,
    ));
  }, undefined);
}

/** The memory was wiped (restart, character creation, a cleared panel). */
export async function dropMemoryVersions(sessionId: string): Promise<void> {
  await unlessTableMissing(async () => {
    await db.delete(sessionMemoryVersions).where(eq(sessionMemoryVersions.sessionId, sessionId));
  }, undefined);
}

