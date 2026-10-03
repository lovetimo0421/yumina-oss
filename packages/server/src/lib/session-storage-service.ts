import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { mediaRows, MediaError } from "./session-media-service.js";

type Executor = Pick<DrizzleDB, "execute">;
type Scope = { sessionId: string } | { shareId: string };
type StoredRow = { key: string; value: unknown; version: number; deleted: boolean; size_bytes: number };
export const SESSION_STORAGE_LIMITS = {
  valueBytes: 32 * 1024,
  liveBytes: 256 * 1024,
  historyBytes: 16 * 1024 * 1024,
  keys: 128,
  writesPerHour: 1000,
} as const;

function validKey(key: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(key)) {
    throw new MediaError("SESSION_STORAGE_INVALID_KEY");
  }
}

function encodeValue(value: unknown): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { /* invalid JSON */ }
  if (encoded === undefined) throw new MediaError("SESSION_STORAGE_INVALID_VALUE");
  if (Buffer.byteLength(encoded) > SESSION_STORAGE_LIMITS.valueBytes) {
    throw new MediaError("SESSION_STORAGE_VALUE_TOO_LARGE", 413);
  }
  // This API stores JSON metadata. Files and device-local URLs belong in media.
  const containsFile = (item: unknown): boolean => typeof item === "string"
    ? /^(?:data:[^,]*;base64,|blob:)/i.test(item)
    : !!item && typeof item === "object" && Object.values(item).some(containsFile);
  if (containsFile(JSON.parse(encoded))) throw new MediaError("SESSION_STORAGE_USE_MEDIA_API");
  return encoded;
}

const resultOf = (row?: StoredRow) => ({
  value: row && !row.deleted ? row.value : null,
  version: row?.version ?? 0,
  exists: !!row && !row.deleted,
});

/** Explicit cloud JSON data, isolated from browser preferences and AI variables. */
export function createSessionStorageService(db: DrizzleDB) {
  async function ownSession(tx: Executor, userId: string, sessionId: string) {
    const [row] = await mediaRows(tx, sql`SELECT id FROM play_sessions WHERE id=${sessionId} AND user_id=${userId}`);
    if (!row) throw new MediaError("SESSION_STORAGE_NOT_FOUND", 404);
  }

  async function read(scope: Scope, key: string) {
    validKey(key);
    const condition = "sessionId" in scope
      ? sql`session_id=${scope.sessionId} AND removed_at IS NULL`
      : sql`share_id=${scope.shareId}`;
    const [row] = await mediaRows<StoredRow>(db, sql`SELECT key,value,version,deleted,size_bytes FROM session_storage WHERE ${condition} AND key=${key} LIMIT 1`);
    return resultOf(row);
  }

  async function get(userId: string, sessionId: string, key: string) {
    await ownSession(db, userId, sessionId);
    return read({ sessionId }, key);
  }

  async function write(userId: string, sessionId: string, key: string, value: unknown, expectedVersion: number, deleted = false) {
    validKey(key);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new MediaError("SESSION_STORAGE_INVALID_VERSION");
    }
    const encoded = deleted ? "null" : encodeValue(value);
    const size = deleted ? 0 : Buffer.byteLength(encoded);
    return db.transaction(async (tx) => {
      // Match media/snapshot lock ordering. Quotas and CAS include all devices.
      await tx.execute(sql`SELECT id FROM "user" WHERE id=${userId} FOR UPDATE`);
      await ownSession(tx, userId, sessionId);
      const [current] = await mediaRows<StoredRow>(tx, sql`SELECT key,value,version,deleted,size_bytes FROM session_storage WHERE session_id=${sessionId} AND key=${key} AND removed_at IS NULL`);
      if ((current?.version ?? 0) !== expectedVersion) throw new MediaError("SESSION_STORAGE_CONFLICT", 409);
      // An acknowledged retry need not manufacture another historical revision.
      if (current && current.deleted === deleted && (deleted || isDeepStrictEqual(current.value, JSON.parse(encoded)))) {
        return resultOf(current);
      }
      const [usage] = await mediaRows<{ live: string; history: string; keys: number; writes: number }>(tx, sql`
        SELECT COALESCE(sum(size_bytes) FILTER(WHERE removed_at IS NULL),0)::text AS live,
          COALESCE(sum(size_bytes),0)::text AS history,
          count(*) FILTER(WHERE removed_at IS NULL)::int AS keys,
          (SELECT count(*) FROM session_storage d JOIN play_sessions s ON s.id=d.session_id
            WHERE s.user_id=${userId} AND d.added_at>now()-interval '1 hour')::int AS writes
        FROM session_storage WHERE session_id=${sessionId}`);
      if (Number(usage?.writes ?? 0) >= SESSION_STORAGE_LIMITS.writesPerHour) throw new MediaError("SESSION_STORAGE_RATE_LIMIT", 429);
      if ((!current && Number(usage?.keys ?? 0) >= SESSION_STORAGE_LIMITS.keys)
        || Number(usage?.live ?? 0) - (current?.size_bytes ?? 0) + size > SESSION_STORAGE_LIMITS.liveBytes
        || Number(usage?.history ?? 0) + size > SESSION_STORAGE_LIMITS.historyBytes) {
        throw new MediaError("SESSION_STORAGE_QUOTA_EXCEEDED", 413);
      }
      await tx.execute(sql`UPDATE session_storage SET removed_at=clock_timestamp() WHERE session_id=${sessionId} AND key=${key} AND removed_at IS NULL`);
      const [row] = await mediaRows<StoredRow>(tx, sql`INSERT INTO session_storage(id,session_id,key,value,version,deleted,size_bytes)
        VALUES(${randomUUID()},${sessionId},${key},${encoded}::jsonb,
          (SELECT COALESCE(max(version),0)+1 FROM session_storage WHERE session_id=${sessionId} AND key=${key}),${deleted},${size})
        RETURNING key,value,version,deleted,size_bytes`);
      return resultOf(row);
    });
  }

  /** Caller MUST have passed the existing playthrough visibility/age/block gates. */
  const readShared = (shareId: string, key: string) => read({ shareId }, key);
  return { get, write, readShared };
}

/** Called under the media owner lock, inside the checkpoint restore transaction. */
export async function restoreSessionStorage(tx: Executor, sessionId: string, checkpointId: string) {
  const desired = await mediaRows<StoredRow & { current_id: string | null; changed: boolean }>(tx, sql`
    SELECT k.key,COALESCE(c.value,'null'::jsonb) AS value,
      (SELECT COALESCE(max(h.version),0)+1 FROM session_storage h WHERE h.session_id=${sessionId} AND h.key=k.key) AS version,
      COALESCE(c.deleted,true) AS deleted,COALESCE(c.size_bytes,0) AS size_bytes,
      live.id AS current_id,
      (live.id IS NULL OR live.value IS DISTINCT FROM COALESCE(c.value,'null'::jsonb)
        OR live.deleted IS DISTINCT FROM COALESCE(c.deleted,true)) AS changed
    FROM (SELECT key FROM session_storage WHERE session_id=${sessionId} OR checkpoint_id=${checkpointId} GROUP BY key) k
    LEFT JOIN session_storage c ON c.checkpoint_id=${checkpointId} AND c.key=k.key
    LEFT JOIN session_storage live ON live.session_id=${sessionId} AND live.key=k.key AND live.removed_at IS NULL`);
  const changed = desired.filter(row => row.changed);
  if (changed.length) {
    const [usage] = await mediaRows<{ history: string; writes: number }>(tx, sql`
      SELECT COALESCE(sum(size_bytes),0)::text AS history,
        (SELECT count(*) FROM session_storage d JOIN play_sessions s ON s.id=d.session_id
          WHERE s.user_id=(SELECT user_id FROM play_sessions WHERE id=${sessionId})
            AND d.added_at>now()-interval '1 hour')::int AS writes
      FROM session_storage WHERE session_id=${sessionId}`);
    // Restore shares the write budget: never bypass it by repeatedly restoring
    // a checkpoint. Fail before mutation; the caller rolls back media and story
    // restoration in the same transaction. Retain history needed by branches.
    if (Number(usage?.writes ?? 0) + changed.length > SESSION_STORAGE_LIMITS.writesPerHour) {
      throw new MediaError("SESSION_STORAGE_RATE_LIMIT", 429);
    }
    if (Number(usage?.history ?? 0) + changed.reduce((sum, row) => sum + row.size_bytes, 0) > SESSION_STORAGE_LIMITS.historyBytes
      || desired.reduce((sum, row) => sum + row.size_bytes, 0) > SESSION_STORAGE_LIMITS.liveBytes
      || desired.length > SESSION_STORAGE_LIMITS.keys) {
      throw new MediaError("SESSION_STORAGE_QUOTA_EXCEEDED", 413);
    }
  }
  const unchanged = desired.filter(row => !row.changed);
  if (unchanged.length) {
    // The value's timeline did not change. Invalidate stale clients without
    // storing another copy or changing added_at (older branches need it).
    await tx.execute(sql`UPDATE session_storage live SET version=restored.version
      FROM jsonb_to_recordset(${JSON.stringify(unchanged.map(row => ({ id: row.current_id, version: row.version })))}::jsonb)
        AS restored(id text,version integer) WHERE live.id=restored.id`);
  }
  if (changed.length) {
    // Batch keys to avoid a network round trip for every key in a full save.
    await tx.execute(sql`UPDATE session_storage SET removed_at=clock_timestamp()
      WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(changed.map(row => row.current_id).filter(Boolean))}::jsonb))`);
    // Keys absent in the checkpoint become versioned tombstones, never v0.
    await tx.execute(sql`INSERT INTO session_storage(id,session_id,key,value,version,deleted,size_bytes)
      SELECT gen_random_uuid()::text,${sessionId},key,COALESCE(value,'null'::jsonb),version,deleted,size_bytes
      FROM jsonb_to_recordset(${JSON.stringify(changed)}::jsonb)
        AS restored(key text,value jsonb,version integer,deleted boolean,size_bytes integer)`);
  }
}
