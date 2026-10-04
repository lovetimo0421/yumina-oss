import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { ASSET_ARCHIVE_LIMITS, isAssetArchiveFilename, type AssetImportJob, type AssetImportStatus } from "@yumina/shared";
import type { DrizzleDB } from "../db/index.js";
import { AssetImportError, visitAssetArchive, type ArchiveFile } from "./asset-archive.js";
import { mediaRows } from "./session-media-service.js";

type Executor = Pick<DrizzleDB, "execute">;
type JobRow = {
  id: string; user_id: string; filename: string; folder_id: string | null;
  status: AssetImportStatus; input_bytes: string | number; expanded_bytes: string | number;
  reserved_bytes: string | number; file_count: number; ignored_count: number;
  preserve_folders: boolean; conflict: "rename" | "skip"; error_code: string | null;
  lease_token: string | null; expires_at: Date | string; updated_at: Date | string;
  upload_expires_at: Date | string; dismissed_at: Date | string | null; cleaned_at: Date | string | null;
};
type EntryRow = {
  ordinal: number; path: string; size_bytes: string | number; mime_type: string;
  asset_type: string; asset_id: string; status: "pending" | "succeeded" | "skipped" | "failed"; error_code: string | null;
};

export interface AssetImportStorage {
  signUpload(key: string, size: number): Promise<string>;
  head(key: string): Promise<{ contentLength: number; etag: string | null }>;
  copy(source: string, destination: string, etag: string): Promise<void>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  write(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface AssetImportDependencies {
  db: DrizzleDB;
  storage: AssetImportStorage;
  quota: {
    lockOwner(tx: Executor, userId: string): Promise<void>;
    usage(userId: string, tx?: Executor): Promise<{ used: number; reserved: number }>;
    limit(userId: string): Promise<number>;
  };
}

const prefix = (job: Pick<JobRow, "user_id" | "id">) => `private-asset-imports/${job.user_id}/${job.id}/`;
const assetKey = (job: Pick<JobRow, "user_id" | "id">, entry: Pick<EntryRow, "asset_id">) => `users/${job.user_id}/imports/${job.id}/${entry.asset_id}`;
const recoverable = new Set(["ARCHIVE_STORAGE_ERROR", "ARCHIVE_INTERRUPTED", "ARCHIVE_QUOTA_EXCEEDED"]);
const iso = (date: Date | string) => new Date(date).toISOString();

export function createAssetImportService({ db, storage, quota }: AssetImportDependencies) {
  let ready = false;
  async function requireReady() {
    if (!ready) {
      const [row] = await mediaRows<{ ready: boolean }>(db, sql`SELECT to_regclass('asset_import_entries') IS NOT NULL AS ready`);
      ready = !!row?.ready;
    }
    if (!ready) throw new AssetImportError("ARCHIVE_UNAVAILABLE", 503);
  }
  async function own(tx: Executor, userId: string, id: string, lock = false): Promise<JobRow> {
    const [job] = await mediaRows<JobRow>(tx, sql`SELECT * FROM asset_import_jobs WHERE id=${id} AND user_id=${userId} ${lock ? sql`FOR UPDATE` : sql``}`);
    if (!job) throw new AssetImportError("ARCHIVE_NOT_FOUND", 404);
    return job;
  }
  function unexpired(job: JobRow) {
    if (new Date(job.expires_at).getTime() <= Date.now()) throw new AssetImportError("ARCHIVE_EXPIRED", 409);
  }
  async function checkFolder(tx: Executor, userId: string, id: string | null) {
    if (id === null) return;
    const [folder] = await mediaRows(tx, sql`SELECT id FROM asset_folders WHERE id=${id} AND user_id=${userId}`);
    if (!folder) throw new AssetImportError("ARCHIVE_FOLDER_MISSING", 404);
  }
  async function entries(tx: Executor, id: string) {
    return mediaRows<EntryRow>(tx, sql`SELECT * FROM asset_import_entries WHERE job_id=${id} ORDER BY ordinal`);
  }
  async function detail(userId: string, id: string): Promise<AssetImportJob> {
    await requireReady();
    const job = await own(db, userId, id);
    const items = await entries(db, id);
    const folders = new Map<string, number>();
    for (const item of items) {
      const slash = item.path.lastIndexOf("/");
      const folder = slash < 0 ? "" : item.path.slice(0, slash);
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
    return {
      id, filename: job.filename, folderId: job.folder_id, status: job.status,
      inputBytes: Number(job.input_bytes), expandedBytes: Number(job.expanded_bytes),
      fileCount: job.file_count, ignoredCount: job.ignored_count,
      succeeded: items.filter(e => e.status === "succeeded").length,
      skipped: items.filter(e => e.status === "skipped").length,
      failed: items.filter(e => e.status === "failed").length,
      preserveFolders: job.preserve_folders, conflict: job.conflict, errorCode: job.error_code,
      failures: items.filter(e => e.status === "failed").slice(0, 50).map(e => ({ path: e.path, code: e.error_code ?? "ARCHIVE_STORAGE_ERROR" })),
      folders: [...folders].slice(0, 50).map(([path, count]) => ({ path, count })),
      expiresAt: iso(job.expires_at), updatedAt: iso(job.updated_at),
    };
  }
  async function list(userId: string) {
    await requireReady();
    const jobs = await mediaRows<{ id: string }>(db, sql`SELECT id FROM asset_import_jobs WHERE user_id=${userId} AND dismissed_at IS NULL AND status NOT IN ('cancelled','expired') AND expires_at>now() ORDER BY created_at DESC LIMIT 10`);
    return Promise.all(jobs.map(job => detail(userId, job.id)));
  }
  async function reserve(userId: string, input: { id: string; filename: string; size: number; folderId: string | null }) {
    await requireReady();
    if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.id) || !isAssetArchiveFilename(input.filename) || input.filename.length > 200) throw new AssetImportError("ARCHIVE_UNSUPPORTED");
    if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > ASSET_ARCHIVE_LIMITS.compressedBytes) throw new AssetImportError("ARCHIVE_TOO_LARGE", 413);
    const limit = await quota.limit(userId);
    const job = await db.transaction(async tx => {
      await quota.lockOwner(tx, userId);
      const [existing] = await mediaRows<JobRow>(tx, sql`SELECT * FROM asset_import_jobs WHERE id=${input.id}`);
      if (existing) {
        if (existing.user_id !== userId) throw new AssetImportError("ARCHIVE_NOT_FOUND", 404);
        if (existing.filename !== input.filename || Number(existing.input_bytes) !== input.size || existing.folder_id !== input.folderId || existing.status !== "uploading") throw new AssetImportError("ARCHIVE_CONFLICT", 409);
        unexpired(existing);
        await tx.execute(sql`UPDATE asset_import_jobs SET upload_expires_at=now()+interval '1 hour' WHERE id=${input.id}`);
        return existing;
      }
      await checkFolder(tx, userId, input.folderId);
      const [rate] = await mediaRows<{ recent: number; active: number }>(tx, sql`SELECT count(*) FILTER (WHERE created_at>now()-interval '1 hour')::int AS recent, count(*) FILTER (WHERE status IN ('uploading','queued_inspect','inspecting','ready','queued','processing','partial') AND expires_at>now())::int AS active FROM asset_import_jobs WHERE user_id=${userId}`);
      if ((rate?.recent ?? 0) >= 10 || (rate?.active ?? 0) >= 4) throw new AssetImportError("ARCHIVE_RATE_LIMIT", 429);
      const usage = await quota.usage(userId, tx);
      if (usage.used + usage.reserved + input.size > limit) throw new AssetImportError("ARCHIVE_QUOTA_EXCEEDED", 413);
      const [created] = await mediaRows<JobRow>(tx, sql`INSERT INTO asset_import_jobs(id,user_id,filename,folder_id,input_bytes,reserved_bytes) VALUES(${input.id},${userId},${input.filename},${input.folderId},${input.size},${input.size}) RETURNING *`);
      return created!;
    });
    return { job: await detail(userId, job.id), uploadUrl: await storage.signUpload(prefix(job) + "upload", input.size) };
  }
  async function uploaded(userId: string, id: string) {
    await requireReady();
    await db.transaction(async tx => {
      await quota.lockOwner(tx, userId);
      const job = await own(tx, userId, id, true);
      unexpired(job);
      if (job.status !== "uploading") return;
      const key = prefix(job);
      const inspected = await storage.head(key + "upload");
      if (!inspected.etag || inspected.contentLength !== Number(job.input_bytes)) throw new AssetImportError("ARCHIVE_UPLOAD_INCOMPLETE", 409);
      // Freeze bytes before inspection. A still-valid presigned PUT cannot mutate them.
      await storage.copy(key + "upload", key + "source", inspected.etag);
      await tx.execute(sql`UPDATE asset_import_jobs SET status='queued_inspect',updated_at=now() WHERE id=${id}`);
    });
    return detail(userId, id);
  }
  async function start(userId: string, id: string, settings: { preserveFolders: boolean; conflict: "rename" | "skip" }) {
    await requireReady();
    const limit = await quota.limit(userId);
    await db.transaction(async tx => {
      await quota.lockOwner(tx, userId);
      const job = await own(tx, userId, id, true);
      unexpired(job);
      if (["queued", "processing", "completed", "partial"].includes(job.status)) return;
      if (job.status !== "ready") throw new AssetImportError("ARCHIVE_NOT_READY", 409);
      await checkFolder(tx, userId, job.folder_id);
      const usage = await quota.usage(userId, tx);
      if (usage.used + usage.reserved > limit) throw new AssetImportError("ARCHIVE_QUOTA_EXCEEDED", 413);
      await tx.execute(sql`UPDATE asset_import_jobs SET status='queued',preserve_folders=${settings.preserveFolders},conflict=${settings.conflict},updated_at=now(),error_code=NULL WHERE id=${id}`);
    });
    return detail(userId, id);
  }
  async function retry(userId: string, id: string) {
    await requireReady();
    const limit = await quota.limit(userId);
    await db.transaction(async tx => {
      await quota.lockOwner(tx, userId);
      const job = await own(tx, userId, id, true);
      unexpired(job);
      if (["queued", "processing", "queued_inspect", "inspecting"].includes(job.status)) return;
      if (job.dismissed_at || job.status !== "partial" && !(job.status === "failed" && recoverable.has(job.error_code ?? ""))) throw new AssetImportError("ARCHIVE_NOT_RETRYABLE", 409);
      const items = await entries(tx, id);
      const remaining = items.filter(e => e.status === "failed" || e.status === "pending").reduce((sum, e) => sum + Number(e.size_bytes), 0);
      const reservation = items.length ? remaining : Number(job.input_bytes);
      const usage = await quota.usage(userId, tx);
      if (usage.used + usage.reserved - Number(job.reserved_bytes) + reservation > limit) throw new AssetImportError("ARCHIVE_QUOTA_EXCEEDED", 413);
      await checkFolder(tx, userId, job.folder_id);
      await tx.execute(sql`UPDATE asset_import_entries SET status='pending',error_code=NULL WHERE job_id=${id} AND status='failed'`);
      await tx.execute(sql`UPDATE asset_import_jobs SET status=${items.length ? "queued" : "queued_inspect"},reserved_bytes=${reservation},error_code=NULL,updated_at=now() WHERE id=${id}`);
    });
    return detail(userId, id);
  }
  async function dismiss(userId: string, id: string) {
    await requireReady();
    await db.transaction(async tx => {
      await quota.lockOwner(tx, userId);
      const job = await own(tx, userId, id, true);
      if (["queued_inspect", "inspecting", "queued", "processing"].includes(job.status)) throw new AssetImportError("ARCHIVE_BUSY", 409);
      await tx.execute(sql`UPDATE asset_import_jobs SET dismissed_at=now(),status=${["uploading", "ready"].includes(job.status) ? "cancelled" : job.status},reserved_bytes=0,updated_at=now() WHERE id=${id}`);
    });
  }
  async function fenced(tx: Executor, job: JobRow) {
    const current = await own(tx, job.user_id, job.id, true);
    if (current.lease_token !== job.lease_token || current.status !== job.status) throw new AssetImportError("ARCHIVE_INTERRUPTED", 409);
    return current;
  }
  async function inspect(job: JobRow, bytes: Buffer, signal: AbortSignal) {
    const manifest: ArchiveFile[] = [];
    const summary = await visitAssetArchive(bytes, job.filename, async file => { manifest.push(file); }, signal);
    const expanded = manifest.reduce((sum, file) => sum + file.size, 0);
    const limit = await quota.limit(job.user_id);
    await db.transaction(async tx => {
      await quota.lockOwner(tx, job.user_id);
      const current = await fenced(tx, job);
      const usage = await quota.usage(job.user_id, tx);
      if (usage.used + usage.reserved - Number(current.reserved_bytes) + expanded > limit) throw new AssetImportError("ARCHIVE_QUOTA_EXCEEDED", 413);
      await tx.execute(sql`DELETE FROM asset_import_entries WHERE job_id=${job.id}`);
      // One statement per bounded batch keeps a 2,000-file manifest inexpensive.
      for (let offset = 0; offset < manifest.length; offset += 200) {
        const values = manifest.slice(offset, offset + 200).map((file, index) => sql`(${job.id},${offset + index},${file.path},${file.size},${file.mimeType},${file.type},${randomUUID()})`);
        await tx.execute(sql`INSERT INTO asset_import_entries(job_id,ordinal,path,size_bytes,mime_type,asset_type,asset_id) VALUES ${sql.join(values, sql`,`)}`);
      }
      await tx.execute(sql`UPDATE asset_import_jobs SET status='ready',file_count=${manifest.length},ignored_count=${summary.ignored},expanded_bytes=${expanded},reserved_bytes=${expanded},lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=${job.id}`);
    });
  }
  async function destination(tx: Executor, job: JobRow, path: string) {
    await checkFolder(tx, job.user_id, job.folder_id);
    let folder = job.folder_id;
    const parts = path.split("/");
    const filename = parts.pop()!;
    if (job.preserve_folders) {
      for (const name of parts) {
        const [existing] = await mediaRows<{ id: string }>(tx, sql`SELECT id FROM asset_folders WHERE user_id=${job.user_id} AND parent_folder_id IS NOT DISTINCT FROM ${folder} AND name=${name} ORDER BY id LIMIT 1`);
        if (existing) folder = existing.id;
        else {
          const id = randomUUID();
          await tx.execute(sql`INSERT INTO asset_folders(id,user_id,name,parent_folder_id) VALUES(${id},${job.user_id},${name},${folder})`);
          folder = id;
        }
      }
    }
    const siblings = await mediaRows<{ filename: string }>(tx, sql`SELECT filename FROM user_assets WHERE user_id=${job.user_id} AND folder_id IS NOT DISTINCT FROM ${folder}`);
    const names = new Set(siblings.map(e => e.filename));
    if (!names.has(filename)) return { folder, filename };
    if (job.conflict === "skip") return null;
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    let count = 2;
    while (names.has(`${stem} (${count})${ext}`)) count++;
    return { folder, filename: `${stem} (${count})${ext}` };
  }
  async function importFiles(job: JobRow, bytes: Buffer, signal: AbortSignal) {
    const pending = new Map((await entries(db, job.id)).filter(e => e.status === "pending" || e.status === "failed").map(e => [e.path, e]));
    const limit = await quota.limit(job.user_id);
    await visitAssetArchive(bytes, job.filename, async (file, data) => {
      signal.throwIfAborted();
      const entry = pending.get(file.path);
      if (!entry) return;
      if (file.size !== Number(entry.size_bytes) || file.mimeType !== entry.mime_type) throw new AssetImportError("ARCHIVE_INVALID");
      try {
        await db.transaction(async tx => {
          await quota.lockOwner(tx, job.user_id);
          await fenced(tx, job);
          const [current] = await mediaRows<EntryRow>(tx, sql`SELECT * FROM asset_import_entries WHERE job_id=${job.id} AND ordinal=${entry.ordinal} FOR UPDATE`);
          if (!current || ["succeeded", "skipped"].includes(current.status)) return;
          const target = await destination(tx, job, entry.path);
          if (target) {
            const usage = await quota.usage(job.user_id, tx);
            if (usage.used + usage.reserved > limit) throw new AssetImportError("ARCHIVE_QUOTA_EXCEEDED", 413);
            signal.throwIfAborted();
            // Stable per-entry key + same-transaction status makes retries idempotent,
            // including a PUT that succeeded just before the process was interrupted.
            await storage.write(assetKey(job, entry), data, entry.mime_type);
            signal.throwIfAborted();
            await tx.execute(sql`INSERT INTO user_assets(id,user_id,type,filename,url,size_bytes,mime_type,folder_id) VALUES(${entry.asset_id},${job.user_id},${entry.asset_type},${target.filename},${assetKey(job, entry)},${data.length},${entry.mime_type},${target.folder})`);
          }
          await tx.execute(sql`UPDATE asset_import_entries SET status=${target ? "succeeded" : "skipped"},error_code=NULL WHERE job_id=${job.id} AND ordinal=${entry.ordinal}`);
          await tx.execute(sql`UPDATE asset_import_jobs SET reserved_bytes=GREATEST(0,reserved_bytes-${file.size}),updated_at=now() WHERE id=${job.id}`);
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AssetImportError && error.code === "ARCHIVE_INTERRUPTED") throw error;
        const code = error instanceof AssetImportError ? error.code : "ARCHIVE_STORAGE_ERROR";
        // Fenced update: a stale worker cannot overwrite a later attempt's success.
        await db.execute(sql`UPDATE asset_import_entries SET status='failed',error_code=${code} WHERE job_id=${job.id} AND ordinal=${entry.ordinal} AND status IN ('pending','failed') AND EXISTS(SELECT 1 FROM asset_import_jobs WHERE id=${job.id} AND lease_token=${job.lease_token})`);
      }
    }, signal);
    await db.transaction(async tx => {
      await quota.lockOwner(tx, job.user_id);
      await fenced(tx, job);
      const [counts] = await mediaRows<{ remaining: number; bytes: string }>(tx, sql`SELECT count(*)::int AS remaining,COALESCE(sum(size_bytes),0)::text AS bytes FROM asset_import_entries WHERE job_id=${job.id} AND status IN ('failed','pending')`);
      await tx.execute(sql`UPDATE asset_import_jobs SET status=${counts?.remaining ? "partial" : "completed"},reserved_bytes=${Number(counts?.bytes ?? 0)},lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=${job.id}`);
    });
  }
  /** One durable claim, suitable for multiple server replicas and restart recovery. */
  async function processNext(): Promise<boolean> {
    await requireReady();
    const token = randomUUID();
    const [job] = await mediaRows<JobRow>(db, sql`UPDATE asset_import_jobs SET lease_token=${token},lease_expires_at=now()+interval '2 minutes',status=CASE WHEN status IN ('queued_inspect','inspecting') THEN 'inspecting' ELSE 'processing' END,updated_at=now() WHERE id=(SELECT id FROM asset_import_jobs WHERE expires_at>now() AND (status IN ('queued_inspect','queued') OR (status IN ('inspecting','processing') AND lease_expires_at<now())) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
    if (!job) return false;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void mediaRows(db, sql`UPDATE asset_import_jobs SET lease_expires_at=now()+interval '2 minutes' WHERE id=${job.id} AND lease_token=${token} RETURNING id`)
        .then(rows => { if (!rows.length) controller.abort(); })
        .catch(() => controller.abort()).finally(() => { renewing = false; });
    }, 20_000);
    heartbeat.unref();
    try {
      const bytes = await storage.read(prefix(job) + "source", ASSET_ARCHIVE_LIMITS.compressedBytes);
      signal.throwIfAborted();
      if (bytes.length !== Number(job.input_bytes)) throw new AssetImportError("ARCHIVE_INVALID");
      if (job.status === "inspecting") await inspect(job, bytes, signal);
      else await importFiles(job, bytes, signal);
    } catch (error) {
      const code = signal.aborted ? "ARCHIVE_INTERRUPTED" : error instanceof AssetImportError ? error.code : "ARCHIVE_STORAGE_ERROR";
      await db.execute(sql`UPDATE asset_import_jobs SET status='failed',error_code=${code},reserved_bytes=0,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=${job.id} AND lease_token=${token}`);
    } finally { clearInterval(heartbeat); }
    return true;
  }
  async function sweep() {
    await requireReady();
    const candidates = await mediaRows<JobRow>(db, sql`SELECT * FROM asset_import_jobs WHERE cleaned_at IS NULL AND upload_expires_at<now()-interval '2 minutes' AND (expires_at<now() OR status IN ('completed','cancelled') OR dismissed_at IS NOT NULL) AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY created_at LIMIT 20`);
    for (const candidate of candidates) {
      const token = randomUUID();
      try {
        const job = await db.transaction(async tx => {
          await quota.lockOwner(tx, candidate.user_id);
          // Recheck eligibility while claiming: another replica may have renewed
          // the worker lease since the candidate query. A terminal transition
          // fences workers/retries before storage is touched and frees quota even
          // when object storage is unavailable.
          const [claimed] = await mediaRows<JobRow>(tx, sql`UPDATE asset_import_jobs
            SET status=CASE WHEN status IN ('completed','cancelled') THEN status ELSE 'expired' END,
                reserved_bytes=0,lease_token=${token},lease_expires_at=now()+interval '2 minutes',updated_at=now()
            WHERE id=${candidate.id} AND cleaned_at IS NULL AND upload_expires_at<now()-interval '2 minutes'
              AND (expires_at<now() OR status IN ('completed','cancelled') OR dismissed_at IS NOT NULL)
              AND (lease_expires_at IS NULL OR lease_expires_at<now()) RETURNING *`);
          return claimed;
        });
        if (!job) continue;
        const keys = [prefix(job) + "source", prefix(job) + "upload",
          ...(await entries(db, job.id)).filter(entry => entry.status !== "succeeded").map(entry => assetKey(job, entry))];
        // Never hold a database transaction open across potentially thousands
        // of object-store round trips (production has a 60s idle timeout).
        for (let offset = 0; offset < keys.length; offset += 8) {
          const renewed = await mediaRows(db, sql`UPDATE asset_import_jobs SET lease_expires_at=now()+interval '2 minutes' WHERE id=${job.id} AND lease_token=${token} RETURNING id`);
          if (!renewed.length) throw new AssetImportError("ARCHIVE_INTERRUPTED", 409);
          const removed = await Promise.allSettled(keys.slice(offset, offset + 8).map(key => storage.remove(key)));
          const failed = removed.find(result => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
        await db.execute(sql`UPDATE asset_import_jobs SET lease_token=NULL,lease_expires_at=NULL,cleaned_at=now(),updated_at=now() WHERE id=${job.id} AND lease_token=${token}`);
      } catch {
        // Successful deletes are idempotent. Keep the durable row for another
        // sweep, but never clear a newer worker's cleanup claim.
        await db.execute(sql`UPDATE asset_import_jobs SET lease_token=NULL,lease_expires_at=NULL WHERE id=${candidate.id} AND lease_token=${token}`);
      }
    }
    await db.execute(sql`DELETE FROM asset_import_jobs WHERE cleaned_at<now()-interval '7 days'`);
  }
  return { reserve, uploaded, detail, list, start, retry, dismiss, processNext, sweep };
}
