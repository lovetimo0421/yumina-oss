import { sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { CREATIVE_UPLOAD_FILES_PER_HOUR, creativeUploadBytesPerHour } from "@yumina/shared";
export { creativeUploadPolicy, CREATIVE_UPLOAD_FILES_PER_HOUR, creativeUploadBytesPerHour } from "@yumina/shared";
import { mediaRows } from "./session-media-service.js";

/** Caller must hold the same owner lock used by storage quota reservations.
 * source is supplied by server code, never copied from request metadata.
 * This measures admitted content, not raw network traffic / retransmissions. */
export async function admitCreativeUpload(
  tx: Pick<DrizzleDB, "execute">, userId: string, source: "file" | "archive",
  operationId: string, bytes: number, storageLimit: number,
): Promise<"admitted" | "limit" | "conflict"> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "conflict";
  const [existing] = await mediaRows<{ bytes: string; completed_at: unknown; stale_archive: boolean }>(tx, sql`
    SELECT bytes,completed_at,admitted_at<=clock_timestamp()-interval '24 hours' AS stale_archive FROM creative_upload_admissions
    WHERE user_id=${userId} AND source_kind=${source} AND operation_id=${operationId}`);
  // A committed file is reconciled by its asset row before this helper runs.
  // After deletion its old request ID cannot mint another unmetered asset.
  // Archive jobs expire within 24h; a recycled ID after job cleanup is not a retry.
  if (existing) return !existing.completed_at && !(source === "archive" && existing.stale_archive)
    && Number(existing.bytes) === bytes ? "admitted" : "conflict";
  const [recent] = await mediaRows<{ bytes: string; files: number }>(tx, sql`
    SELECT COALESCE(sum(bytes),0)::text AS bytes,
      count(*) FILTER (WHERE source_kind='file')::int AS files
    FROM creative_upload_admissions
    WHERE user_id=${userId} AND admitted_at>clock_timestamp()-interval '1 hour'`);
  if (Number(recent?.bytes ?? 0) + bytes > creativeUploadBytesPerHour(storageLimit)
    || source === "file" && (recent?.files ?? 0) >= CREATIVE_UPLOAD_FILES_PER_HOUR) return "limit";
  await tx.execute(sql`INSERT INTO creative_upload_admissions(user_id,source_kind,operation_id,bytes,admitted_at)
    VALUES(${userId},${source},${operationId},${bytes},clock_timestamp())`);
  return "admitted";
}
