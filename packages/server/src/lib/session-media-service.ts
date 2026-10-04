import { sql, type SQL } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { DrizzleDB } from "../db/index.js";
import { MEDIA_INPUT_LIMIT, MEDIA_MIMES, MEDIA_RESERVATION, prepareSessionImage } from "./session-media-image.js";
type Executor = Pick<DrizzleDB, "execute">;
export async function mediaRows<T = Record<string, unknown>>(tx: Executor, query: SQL): Promise<T[]> {
    return (await tx.execute(query)).rows as T[];
}
export class MediaError extends Error {
    constructor(public code: string, public status: 400 | 403 | 404 | 409 | 413 | 429 | 503 = 400) { super(code); }
}
type FileRow = {
    id: string;
    user_id: string;
    filename: string;
    object_key: string;
    thumbnail_key: string;
    size_bytes: number | string;
    status: string;
    revision: number;
    width: number;
    height: number;
    created_at: string;
};
type Upload = {
    id: string;
    user_id: string;
    session_id: string | null;
    entry_id: string;
    filename: string;
    content_type: string;
    input_bytes: number | string;
    reserved_bytes: number | string;
    temp_key: string;
    status: string;
    attempt: string | null;
    metadata: Record<string, unknown>;
    attempts: string[];
    media_id: string | null;
    expires_at: string;
    processing_at: string | null;
};
export type MediaStorage = {
    signUpload(key: string, mime: string, size: number, seconds: number): Promise<string>;
    signRead(key: string): Promise<string>;
    read(key: string, max: number): Promise<Buffer>;
    write(key: string, data: Buffer): Promise<void>;
    remove(key: string): Promise<void>;
};
export type MediaScope = {
    sessionId: string;
} | {
    shareId: string;
};
export const mediaPrefix = (userId: string) => `private-session-media/${userId}/`;
const attemptKeys = (upload: Upload, attempt: string) => {
    const base = `${mediaPrefix(upload.user_id)}objects/${upload.id}/${attempt}`;
    return { main: `${base}/main.webp`, thumbnail: `${base}/thumbnail.webp` };
};
export function parseMediaMetadata(value: unknown): Record<string, unknown> {
    if (value == null)
        return {};
    if (typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 4096)
        throw new MediaError("MEDIA_INVALID_METADATA");
    return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value);
}
export function createSessionMediaService(db: DrizzleDB, storage: MediaStorage) {
    let importsReady = false;
    let ready = false;
    async function isReady(executor: Executor = db) {
        if (ready)
            return true;
        const [row] = await mediaRows<{
            ready: boolean;
        }>(executor, sql `SELECT to_regclass('session_media_documents') IS NOT NULL AS ready`);
        ready = !!row?.ready;
        return ready;
    }
    async function requireReady() { if (!(await isReady()))
        throw new MediaError("MEDIA_NOT_CONFIGURED", 503); }
    async function lockOwner(tx: Executor, userId: string) {
        const rows = await mediaRows(tx, sql `SELECT id FROM "user" WHERE id=${userId} FOR UPDATE`);
        if (!rows.length)
            throw new MediaError("MEDIA_NOT_FOUND", 404);
    }
    async function ownSession(tx: Executor, userId: string, sessionId: string) {
        const [row] = await mediaRows<{
            world_id: string;
        }>(tx, sql `SELECT world_id FROM play_sessions WHERE id=${sessionId} AND user_id=${userId}`);
        if (!row)
            throw new MediaError("MEDIA_NOT_FOUND", 404);
        return row;
    }
    async function usage(userId: string, tx: Executor = db) {
        // Archive jobs share the same account lock/quota as individual uploads.
        // Keep this additive rollout safe before the new tables are installed.
        if (!importsReady) {
            const [tables] = await mediaRows<{ ready: boolean }>(tx, sql`SELECT to_regclass('asset_import_jobs') IS NOT NULL AS ready`);
            importsReady = !!tables?.ready;
        }
        const [imports] = importsReady ? await mediaRows<{ bytes: string }>(tx, sql`SELECT COALESCE(SUM(reserved_bytes),0)::text AS bytes FROM asset_import_jobs WHERE user_id=${userId}`) : [];
        const importReserved = Number(imports?.bytes ?? 0);
        const [old] = await mediaRows<{
            bytes: string;
        }>(tx, sql `SELECT COALESCE(SUM(size_bytes),0)::text AS bytes FROM user_assets WHERE user_id=${userId}`);
        if (!(await isReady(tx)))
            return { used: Number(old?.bytes ?? 0), mediaBytes: 0, reserved: importReserved };
        const [row] = await mediaRows<{
            bytes: string;
            reserved: string;
        }>(tx, sql `
      SELECT (SELECT COALESCE(SUM(size_bytes),0) FROM session_media WHERE user_id=${userId})::text AS bytes,
      (SELECT COALESCE(SUM(reserved_bytes),0) FROM session_media_uploads WHERE user_id=${userId})::text AS reserved`);
        return { used: Number(old?.bytes ?? 0) + Number(row?.bytes ?? 0), mediaBytes: Number(row?.bytes ?? 0), reserved: Number(row?.reserved ?? 0) + importReserved };
    }
    async function reserve(userId: string, limit: number, input: {
        id: string;
        sessionId: string;
        entryId: string;
        filename: string;
        contentType: string;
        size: number;
        metadata?: unknown;
    }) {
        await requireReady();
        if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > MEDIA_INPUT_LIMIT)
            throw new MediaError("MEDIA_INVALID_SIZE", 413);
        if (!MEDIA_MIMES.includes(input.contentType) || !input.filename || input.filename.length > 200 || !/^[a-zA-Z0-9:_-]{1,100}$/.test(input.entryId) || !/^[a-f0-9-]{36}$/i.test(input.id))
            throw new MediaError("MEDIA_INVALID_UPLOAD");
        const metadata = parseMediaMetadata(input.metadata);
        const upload = await db.transaction(async (tx) => {
            await lockOwner(tx, userId);
            await ownSession(tx, userId, input.sessionId);
            const [existing] = await mediaRows<Upload>(tx, sql `SELECT * FROM session_media_uploads WHERE id=${input.id}`);
            if (existing) {
                if (existing.user_id !== userId || existing.session_id !== input.sessionId || existing.entry_id !== input.entryId || Number(existing.input_bytes) !== input.size || existing.content_type !== input.contentType || existing.filename !== input.filename || canonical(existing.metadata) !== canonical(metadata))
                    throw new MediaError("MEDIA_UPLOAD_CONFLICT", 409);
                if (existing.status === "expired" || (existing.status !== "complete" && Date.parse(existing.expires_at) <= Date.now()))
                    throw new MediaError("MEDIA_UPLOAD_EXPIRED", 409);
                return existing;
            }
            const [rate] = await mediaRows<{
                count: number;
                bytes: string;
                pending: number;
            }>(tx, sql `
        SELECT count(*)::int AS count,COALESCE(sum(input_bytes),0)::text AS bytes,
        count(*) FILTER(WHERE status IN ('pending','processing'))::int AS pending
        FROM session_media_uploads WHERE user_id=${userId} AND created_at>now()-interval '1 hour'`);
            if ((rate?.count ?? 0) >= 60 || Number(rate?.bytes ?? 0) + input.size > 128 * 1024 * 1024 || (rate?.pending ?? 0) >= 4)
                throw new MediaError("MEDIA_RATE_LIMIT", 429);
            const used = await usage(userId, tx);
            if (used.used + used.reserved + input.size + MEDIA_RESERVATION > limit)
                throw new MediaError("MEDIA_QUOTA_EXCEEDED", 413);
            const [row] = await mediaRows<Upload>(tx, sql `INSERT INTO session_media_uploads
        (id,user_id,session_id,entry_id,filename,content_type,input_bytes,reserved_bytes,metadata,temp_key,expires_at)
        VALUES(${input.id},${userId},${input.sessionId},${input.entryId},${input.filename},${input.contentType},${input.size},${input.size + MEDIA_RESERVATION},${JSON.stringify(metadata)}::jsonb,${mediaPrefix(userId) + "pending/" + input.id},now()+interval '10 minutes') RETURNING *`);
            return row!;
        });
        if (upload.status === "complete")
            return { id: upload.id, mediaId: upload.media_id, complete: true };
        const seconds = Math.max(1, Math.min(600, Math.floor((Date.parse(upload.expires_at) - Date.now()) / 1000)));
        return { id: upload.id, uploadUrl: await storage.signUpload(upload.temp_key, upload.content_type, Number(upload.input_bytes), seconds), complete: false };
    }
    async function complete(userId: string, uploadId: string, limit: number) {
        await requireReady();
        const attempt = randomUUID();
        const upload = await db.transaction(async (tx) => {
            await lockOwner(tx, userId);
            const [row] = await mediaRows<Upload>(tx, sql `SELECT * FROM session_media_uploads WHERE id=${uploadId} AND user_id=${userId} FOR UPDATE`);
            if (!row)
                throw new MediaError("MEDIA_NOT_FOUND", 404);
            if (row.status === "complete")
                return row;
            if (!row.session_id || row.status === "expired" || Date.parse(row.expires_at) <= Date.now())
                throw new MediaError("MEDIA_UPLOAD_EXPIRED", 409);
            if (row.status === "processing")
                throw new MediaError("MEDIA_PROCESSING", 409);
            if (row.attempts.length >= 3)
                throw new MediaError("MEDIA_UPLOAD_EXPIRED", 409);
            await ownSession(tx, userId, row.session_id);
            const extraReservation = row.attempts.length ? MEDIA_RESERVATION : 0;
            if (extraReservation) {
                const used = await usage(userId, tx);
                if (used.used + used.reserved + extraReservation > limit)
                    throw new MediaError("MEDIA_QUOTA_EXCEEDED", 413);
            }
            await tx.execute(sql `UPDATE session_media_uploads SET status='processing',attempt=${attempt},attempts=attempts || ${JSON.stringify([attempt])}::jsonb,processing_at=now(),reserved_bytes=reserved_bytes+${extraReservation} WHERE id=${uploadId}`);
            return row;
        });
        if (upload.status === "complete") {
            const [live] = await mediaRows(db, sql `SELECT r.id FROM session_media_refs r JOIN session_media m ON m.id=r.media_id
        WHERE r.session_id=${upload.session_id} AND r.entry_id=${upload.entry_id} AND r.media_id=${upload.media_id} AND r.removed_at IS NULL AND m.status='ready'`);
            if (!live)
                throw new MediaError('MEDIA_REFERENCE_CONFLICT', 409);
            return { mediaId: upload.media_id, entryId: upload.entry_id };
        }
        const keys = attemptKeys(upload, attempt);
        try {
            const input = await storage.read(upload.temp_key, MEDIA_INPUT_LIMIT);
            if (input.length !== Number(upload.input_bytes))
                throw new MediaError("MEDIA_SIZE_MISMATCH");
            const image = await prepareSessionImage(input);
            await storage.write(keys.main, image.main);
            await storage.write(keys.thumbnail, image.thumbnail);
            const result = await db.transaction(async (tx) => {
                await lockOwner(tx, userId);
                await ownSession(tx, userId, upload.session_id!);
                const [current] = await mediaRows<Upload>(tx, sql `SELECT * FROM session_media_uploads WHERE id=${uploadId} FOR UPDATE`);
                if (current?.status !== "processing" || current.attempt !== attempt)
                    throw new MediaError("MEDIA_UPLOAD_CONFLICT", 409);
                const used = await usage(userId, tx);
                let [file] = await mediaRows<FileRow>(tx, sql `SELECT * FROM session_media WHERE user_id=${userId} AND hash=${image.hash} AND status='ready'`);
                // Keep originals, failed attempts and deduplicated candidates reserved
                // until cleanup. The successful new file moves into used storage.
                const remainingReservation = Number(upload.input_bytes) + (current.attempts.length - 1) * MEDIA_RESERVATION + (file ? image.size : 0);
                if (used.used + used.reserved - Number(current.reserved_bytes) + remainingReservation + (file ? 0 : image.size) > limit)
                    throw new MediaError("MEDIA_QUOTA_EXCEEDED", 413);
                if (!file) {
                    [file] = await mediaRows<FileRow>(tx, sql `INSERT INTO session_media(id,user_id,filename,hash,object_key,thumbnail_key,size_bytes,width,height)
            VALUES(${randomUUID()},${userId},${upload.filename},${image.hash},${keys.main},${keys.thumbnail},${image.size},${image.width},${image.height}) RETURNING *`);
                }
                const [entry] = await mediaRows<{
                    media_id: string;
                }>(tx, sql `SELECT media_id FROM session_media_refs WHERE session_id=${upload.session_id} AND entry_id=${upload.entry_id} AND removed_at IS NULL`);
                if (entry && entry.media_id !== file!.id)
                    throw new MediaError("MEDIA_ENTRY_CONFLICT", 409);
                if (!entry)
                    await tx.execute(sql `INSERT INTO session_media_refs(id,media_id,session_id,entry_id,metadata,version)
          VALUES(${randomUUID()},${file!.id},${upload.session_id},${upload.entry_id},${JSON.stringify(upload.metadata)}::jsonb,
          (SELECT COALESCE(MAX(version),0)+1 FROM session_media_refs WHERE session_id=${upload.session_id} AND entry_id=${upload.entry_id}))`);
                await tx.execute(sql `UPDATE session_media_uploads SET status='complete',media_id=${file!.id},reserved_bytes=${remainingReservation} WHERE id=${uploadId}`);
                return { mediaId: file!.id, entryId: upload.entry_id };
            });
            // Do not delete candidates here: a lost commit acknowledgement may still
            // mean success. The sweeper checks DB ownership before removing candidates.
            return result;
        }
        catch (error) {
            await db.execute(sql `UPDATE session_media_uploads SET status='pending' WHERE id=${uploadId} AND attempt=${attempt} AND status='processing'`);
            if (error instanceof MediaError)
                throw error;
            throw new MediaError(error instanceof Error && error.message.startsWith("MEDIA_") ? error.message : "MEDIA_PROCESSING_FAILED", 503);
        }
    }
    async function scopeList(scope: MediaScope, offset = 0) {
        if (!(await isReady()))
            return { items: [], hasMore: false };
        const condition = "sessionId" in scope ? sql `r.session_id=${scope.sessionId} AND r.removed_at IS NULL` : sql `r.share_id=${scope.shareId}`;
        const rows = await mediaRows<FileRow & {
            entry_id: string;
            metadata: Record<string, unknown>;
            version: number;
        }>(db, sql `
      SELECT m.*,r.entry_id,r.metadata,r.version FROM session_media_refs r JOIN session_media m ON m.id=r.media_id
      WHERE ${condition} ORDER BY r.added_at,r.id LIMIT 51 OFFSET ${offset}`);
        const docCondition = "sessionId" in scope ? sql `session_id=${scope.sessionId} AND removed_at IS NULL` : sql `share_id=${scope.shareId}`;
        const [document] = await mediaRows<{
            value: Record<string, unknown>;
            version: number;
        }>(db, sql `SELECT value,version FROM session_media_documents WHERE ${docCondition} LIMIT 1`);
        const [history] = "sessionId" in scope ? await mediaRows<{
            present: boolean;
        }>(db, sql `SELECT EXISTS(SELECT 1 FROM session_media_refs WHERE session_id=${scope.sessionId}) AS present`) : [];
        return { initialized: !!document || !!history?.present || rows.length > 0, document: document ?? { value: {}, version: 0 }, items: await Promise.all(rows.slice(0, 50).map(async (r) => ({ id: r.id, entryId: r.entry_id, metadata: r.metadata, version: r.version,
                filename: r.filename, sizeBytes: Number(r.size_bytes), deleted: r.status !== "ready", url: r.status === "ready" ? await storage.signRead(r.object_key) : null,
                thumbnailUrl: r.status === "ready" ? await storage.signRead(r.thumbnail_key) : null }))), hasMore: rows.length > 50 };
    }
    async function ownList(userId: string, opts: {
        offset: number;
        sessionId?: string;
        filter?: string;
        order?: string;
    }) {
        await requireReady();
        const sessionFilter = opts.sessionId ? sql `AND EXISTS(SELECT 1 FROM session_media_refs r WHERE r.media_id=m.id AND r.session_id=${opts.sessionId} AND r.removed_at IS NULL)` : sql ``;
        const filter = opts.filter === "unused" ? sql `AND NOT EXISTS(SELECT 1 FROM session_media_refs r WHERE r.media_id=m.id)` :
            opts.filter === "shared" ? sql `AND EXISTS(SELECT 1 FROM session_media_refs r WHERE r.media_id=m.id AND r.share_id IS NOT NULL)` : sql ``;
        const rows = await mediaRows<FileRow & {has_refs:boolean;has_shares:boolean}>(db, sql `SELECT m.*,
          EXISTS(SELECT 1 FROM session_media_refs r WHERE r.media_id=m.id) AS has_refs,
          EXISTS(SELECT 1 FROM session_media_refs r WHERE r.media_id=m.id AND r.share_id IS NOT NULL) AS has_shares
          FROM session_media m WHERE m.user_id=${userId} AND m.status<>'deleted' ${sessionFilter} ${filter}
      ORDER BY ${opts.order === "size" ? sql `m.size_bytes DESC` : sql `m.created_at DESC`},m.id LIMIT 51 OFFSET ${opts.offset}`);
        const items = await Promise.all(rows.slice(0, 50).map(async (r) => ({ id: r.id, filename: r.filename, sizeBytes: Number(r.size_bytes), width: r.width, height: r.height,
            revision: r.revision, status: r.status, usage:r.has_shares?'shared':r.has_refs?'save':'unused', createdAt: r.created_at, thumbnailUrl: r.status === "ready" ? await storage.signRead(r.thumbnail_key) : null })));
        return { items, hasMore: rows.length > 50 };
    }
    async function detail(userId: string, id: string) {
        await requireReady();
        const [file] = await mediaRows<FileRow>(db, sql `SELECT * FROM session_media WHERE id=${id} AND user_id=${userId}`);
        if (!file)
            throw new MediaError("MEDIA_NOT_FOUND", 404);
        const refs = await mediaRows(db, sql `SELECT r.id,r.session_id AS "sessionId",r.checkpoint_id AS "checkpointId",r.share_id AS "shareId",
      r.entry_id AS "entryId",r.version,r.removed_at IS NOT NULL AS historical,COALESCE(s.name,c.name,p.title,'Untitled') AS name
      FROM session_media_refs r LEFT JOIN play_sessions s ON s.id=r.session_id
      LEFT JOIN checkpoints c ON c.id=r.checkpoint_id LEFT JOIN shared_playthroughs p ON p.id=r.share_id
      WHERE r.media_id=${id} ORDER BY r.added_at DESC LIMIT 200`);
        const [counts] = await mediaRows<{
            count: number;
        }>(db, sql `SELECT count(*)::int AS count FROM session_media_refs WHERE media_id=${id}`);
        return { id: file.id, filename: file.filename, revision: file.revision, status: file.status, sizeBytes: Number(file.size_bytes), references: refs, referenceCount: counts?.count ?? 0,
            url: file.status === "ready" ? await storage.signRead(file.object_key) : null };
    }
    async function unlink(userId: string, sessionId: string, entryId: string, version: number) {
        await requireReady();
        return db.transaction(async (tx) => {
            await lockOwner(tx, userId);
            await ownSession(tx, userId, sessionId);
            const rows = await mediaRows(tx, sql `UPDATE session_media_refs SET removed_at=clock_timestamp() WHERE session_id=${sessionId} AND entry_id=${entryId} AND removed_at IS NULL AND version=${version} RETURNING id`);
            if (!rows.length)
                throw new MediaError("MEDIA_REFERENCE_CONFLICT", 409);
            return { removed: true };
        });
    }
    async function remove(userId: string, id: string, revision: number) {
        await requireReady();
        const file = await db.transaction(async (tx) => {
            await lockOwner(tx, userId);
            const [row] = await mediaRows<FileRow>(tx, sql `SELECT * FROM session_media WHERE id=${id} AND user_id=${userId} FOR UPDATE`);
            if (!row)
                throw new MediaError("MEDIA_NOT_FOUND", 404);
            if (row.status === 'ready' && row.revision !== revision)
                throw new MediaError("MEDIA_REFERENCE_CONFLICT", 409);
            await tx.execute(sql `UPDATE session_media SET status='deleting' WHERE id=${id} AND status='ready'`);
            return row;
        });
        if (file.status === 'deleted')
            return { deleted: true };
        try {
            await storage.remove(file.object_key);
            await storage.remove(file.thumbnail_key);
        }
        catch {
            return { deleted: false, pending: true };
        }
        await db.execute(sql `UPDATE session_media SET status='deleted',size_bytes=0,revision=revision+1 WHERE id=${id}`);
        return { deleted: true };
    }
    async function restore(tx: Executor, userId: string, sessionId: string, checkpointId: string) {
        if (!(await isReady(tx)))
            return;
        await lockOwner(tx, userId);
        await ownSession(tx, userId, sessionId);
        const [cp] = await mediaRows(tx, sql `SELECT id FROM checkpoints WHERE id=${checkpointId} AND session_id=${sessionId}`);
        if (!cp)
            throw new MediaError("MEDIA_NOT_FOUND", 404);
        await tx.execute(sql `UPDATE session_media_refs SET removed_at=clock_timestamp() WHERE session_id=${sessionId} AND removed_at IS NULL`);
        await tx.execute(sql `INSERT INTO session_media_refs(id,media_id,session_id,entry_id,metadata,version)
      SELECT gen_random_uuid()::text,r.media_id,${sessionId},r.entry_id,r.metadata,
        (SELECT COALESCE(MAX(h.version),0)+1 FROM session_media_refs h WHERE h.session_id=${sessionId} AND h.entry_id=r.entry_id)
      FROM session_media_refs r JOIN session_media m ON m.id=r.media_id WHERE r.checkpoint_id=${checkpointId} AND m.status='ready'`);
        await tx.execute(sql `UPDATE session_media_documents SET removed_at=clock_timestamp() WHERE session_id=${sessionId} AND removed_at IS NULL`);
        await tx.execute(sql `INSERT INTO session_media_documents(id,session_id,value,version)
      SELECT gen_random_uuid()::text,${sessionId},value,(SELECT COALESCE(MAX(version),0)+1 FROM session_media_documents WHERE session_id=${sessionId}) FROM session_media_documents WHERE checkpoint_id=${checkpointId}`);
    }
    async function editGallery(userId: string, sessionId: string, changes: {
        entryId: string;
        version: number;
        metadata?: unknown;
        remove?: boolean;
    }[], document?: {
        version: number;
        value: unknown;
    }) {
        await requireReady();
        if (changes.length > 500)
            throw new MediaError('MEDIA_INVALID_REQUEST');
        if (document && (!document.value || typeof document.value !== 'object' || Array.isArray(document.value) || Buffer.byteLength(JSON.stringify(document.value)) > 24 * 1024))
            throw new MediaError('MEDIA_INVALID_METADATA');
        await db.transaction(async (tx) => {
            await lockOwner(tx, userId);
            await ownSession(tx, userId, sessionId);
            const [rate]=await mediaRows<{count:number}>(tx,sql`SELECT (
              (SELECT count(*) FROM session_media_refs r JOIN play_sessions s ON s.id=r.session_id WHERE s.user_id=${userId} AND r.added_at>now()-interval '1 hour')+
              (SELECT count(*) FROM session_media_documents d JOIN play_sessions s ON s.id=d.session_id WHERE s.user_id=${userId} AND d.added_at>now()-interval '1 hour'))::int AS count`);
            if((rate?.count??0)+changes.length+(document?1:0)>1000)throw new MediaError('MEDIA_RATE_LIMIT',429);
            for (const change of changes) {
                const [ref] = await mediaRows<{
                    id: string;
                    media_id: string;
                    version: number;
                }>(tx, sql `SELECT r.id,r.media_id,r.version FROM session_media_refs r JOIN session_media m ON m.id=r.media_id
          WHERE r.session_id=${sessionId} AND r.entry_id=${change.entryId} AND r.removed_at IS NULL AND m.status='ready'`);
                if (!ref || ref.version !== change.version)
                    throw new MediaError('MEDIA_REFERENCE_CONFLICT', 409);
                const metadata = parseMediaMetadata(change.metadata);
                await tx.execute(sql `UPDATE session_media_refs SET removed_at=clock_timestamp() WHERE id=${ref.id}`);
                if (!change.remove)
                    await tx.execute(sql `INSERT INTO session_media_refs(id,media_id,session_id,entry_id,metadata,version)
          VALUES(${randomUUID()},${ref.media_id},${sessionId},${change.entryId},${JSON.stringify(metadata)}::jsonb,${ref.version + 1})`);
            }
            if (document) {
                const [current] = await mediaRows<{
                    version: number;
                }>(tx, sql `SELECT version FROM session_media_documents WHERE session_id=${sessionId} AND removed_at IS NULL`);
                if ((current?.version ?? 0) !== document.version)
                    throw new MediaError('MEDIA_REFERENCE_CONFLICT', 409);
                await tx.execute(sql `UPDATE session_media_documents SET removed_at=clock_timestamp() WHERE session_id=${sessionId} AND removed_at IS NULL`);
                await tx.execute(sql `INSERT INTO session_media_documents(id,session_id,value,version) VALUES(${randomUUID()},${sessionId},${JSON.stringify(document.value)}::jsonb,(SELECT COALESCE(MAX(version),0)+1 FROM session_media_documents WHERE session_id=${sessionId}))`);
            }
        });
    }
    async function sweep() {
        if (!(await isReady()))
            return;
        const uploads = await mediaRows<Upload>(db, sql `UPDATE session_media_uploads SET status=CASE WHEN status='complete' THEN status ELSE 'expired' END
      WHERE id IN (SELECT id FROM session_media_uploads WHERE expires_at<now()-interval '2 minutes' AND cleaned_at IS NULL ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING *`);
        for (const row of uploads) {
            try {
                await storage.remove(row.temp_key);
                if (row.metadata.purpose === 'creative-asset') {
                    const finalKey = `users/${row.user_id}/registered/${createHash('sha256').update(row.temp_key).digest('hex')}`;
                    const [registered] = await mediaRows(db, sql `SELECT id FROM user_assets WHERE user_id=${row.user_id} AND url=${finalKey}`);
                    if (!registered) await storage.remove(finalKey);
                }
                for (const candidate of row.attempts) {
                    const keys = attemptKeys(row, candidate);
                    const [owned] = await mediaRows(db, sql `SELECT id FROM session_media WHERE object_key=${keys.main} AND status<>'deleted'`);
                    if (!owned) {
                        await storage.remove(keys.main);
                        await storage.remove(keys.thumbnail);
                    }
                }
                await db.execute(sql `UPDATE session_media_uploads SET cleaned_at=now(),reserved_bytes=0 WHERE id=${row.id} AND status IN ('complete','expired')`);
            }
            catch { /* Retain reservation and retry on the next sweep. */ }
        }
        const garbage = await mediaRows<FileRow>(db, sql `SELECT * FROM session_media WHERE status='deleting' OR (status='ready' AND unreferenced_at<now()-interval '7 days') LIMIT 100`);
        for (const row of garbage) {
            try {
                await remove(row.user_id, row.id, row.revision);
            }
            catch { /* Changed references or a transient failure: retry. */ }
        }
    }
    return { isReady, usage, ownSession, lockOwner, reserve, complete, scopeList, ownList, detail, unlink, remove, restore, editGallery, sweep };
}
