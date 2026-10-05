import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AssetImportStatus } from "@yumina/shared";
import type { DrizzleDB } from "../db/index.js";
import { AssetImportError } from "./asset-archive.js";
import { mediaRows } from "./session-media-service.js";

export type AssetImportExecutor = Pick<DrizzleDB, "execute">;
export type AssetImportJobRow = {
  id: string; user_id: string; filename: string; folder_id: string | null;
  status: AssetImportStatus; input_bytes: string | number; expanded_bytes: string | number;
  reserved_bytes: string | number; file_count: number; ignored_count: number;
  preserve_folders: boolean; conflict: "rename" | "skip"; error_code: string | null;
  manifest_validated_at: Date | string | null; confirmed_at: Date | string | null;
  queued_at: Date | string | null; priority: number;
  lease_token: string | null; lease_expires_at: Date | string | null;
  expires_at: Date | string; created_at: Date | string; updated_at: Date | string;
  upload_expires_at: Date | string; dismissed_at: Date | string | null; cleaned_at: Date | string | null;
};

export const ASSET_IMPORT_QUEUE_POLICY = {
  // Each minute waiting offsets one membership level. An older free job can
  // therefore overtake newly queued priority-2 work after two minutes.
  agingSeconds: 60,
  leaseSeconds: 120,
  heartbeatMs: 20_000,
  claimCandidates: 32,
} as const;

/** The owner row must be locked first, throughout this transaction. */
export async function lockAssetImportLease(tx: AssetImportExecutor, job: AssetImportJobRow) {
  const [current] = await mediaRows<AssetImportJobRow>(tx, sql`
    SELECT * FROM asset_import_jobs WHERE id=${job.id} AND user_id=${job.user_id}
      AND lease_token=${job.lease_token} AND status=${job.status}
      AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp()
    FOR UPDATE`);
  if (!current) throw new AssetImportError("ARCHIVE_INTERRUPTED", 409);
  return current;
}

/** One valid processing lease per owner, including across service replicas. */
export async function claimAssetImportJob(db: DrizzleDB): Promise<AssetImportJobRow | null> {
  // This read is advisory. The owner lock and rechecks below close the race;
  // locking jobs before owners would invert normal upload/import lock order.
  const candidates = await mediaRows<{ id: string; user_id: string }>(db, sql`
    SELECT j.id,j.user_id FROM asset_import_jobs j
    WHERE j.expires_at>clock_timestamp() AND j.dismissed_at IS NULL AND j.cleaned_at IS NULL
      AND (j.status IN ('queued_inspect','queued') OR
        (j.status IN ('inspecting','processing') AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp())))
      AND NOT EXISTS(SELECT 1 FROM asset_import_jobs active WHERE active.user_id=j.user_id
        AND active.status IN ('inspecting','processing') AND active.lease_expires_at>clock_timestamp())
    ORDER BY j.priority+GREATEST(0,FLOOR(EXTRACT(EPOCH FROM
      (clock_timestamp()-COALESCE(j.queued_at,j.created_at)))/${ASSET_IMPORT_QUEUE_POLICY.agingSeconds})) DESC,
      COALESCE(j.queued_at,j.created_at),j.id
    LIMIT ${ASSET_IMPORT_QUEUE_POLICY.claimCandidates}`);
  for (const candidate of candidates) {
    const claimed = await db.transaction(async tx => {
      // Skip an owner currently settling a file so another account can run.
      const owners = await mediaRows(tx, sql`SELECT id FROM "user" WHERE id=${candidate.user_id} FOR UPDATE SKIP LOCKED`);
      if (!owners.length) return null;
      const active = await mediaRows(tx, sql`SELECT id FROM asset_import_jobs WHERE user_id=${candidate.user_id}
        AND status IN ('inspecting','processing') AND lease_expires_at>clock_timestamp() LIMIT 1`);
      if (active.length) return null;
      const [job] = await mediaRows<AssetImportJobRow>(tx, sql`
        UPDATE asset_import_jobs SET lease_token=${randomUUID()},
          lease_expires_at=clock_timestamp()+${ASSET_IMPORT_QUEUE_POLICY.leaseSeconds}*interval '1 second',
          status=CASE WHEN status IN ('queued_inspect','inspecting') THEN 'inspecting' ELSE 'processing' END,
          updated_at=clock_timestamp()
        WHERE id=${candidate.id} AND user_id=${candidate.user_id} AND expires_at>clock_timestamp()
          AND dismissed_at IS NULL AND cleaned_at IS NULL
          AND (status IN ('queued_inspect','queued') OR
            (status IN ('inspecting','processing') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())))
        RETURNING *`);
      return job ?? null;
    });
    if (claimed) return claimed;
  }
  return null;
}

/** Never revive an expired lease: a different job for this owner may now run. */
export async function renewAssetImportLease(
  db: DrizzleDB,
  lockOwner: (tx: AssetImportExecutor, userId: string) => Promise<void>,
  job: AssetImportJobRow,
): Promise<boolean> {
  return db.transaction(async tx => {
    await lockOwner(tx, job.user_id);
    const renewed = await mediaRows(tx, sql`UPDATE asset_import_jobs
      SET lease_expires_at=clock_timestamp()+${ASSET_IMPORT_QUEUE_POLICY.leaseSeconds}*interval '1 second'
      WHERE id=${job.id} AND user_id=${job.user_id} AND status=${job.status} AND lease_token=${job.lease_token}
        AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp()
      RETURNING id`);
    return renewed.length > 0;
  });
}
