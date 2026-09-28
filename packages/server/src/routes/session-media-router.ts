import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import type { AppEnv } from "../lib/types.js";
import { mediaRows, MediaError, type createSessionMediaService } from "../lib/session-media-service.js";
export function createSessionMediaRoutes(deps: {
    db: DrizzleDB;
    authMiddleware: MiddlewareHandler<AppEnv>;
    sessionMedia: ReturnType<typeof createSessionMediaService>;
    sessionMediaLimit: (id: string) => Promise<number>;
    sessionMediaUploadsEnabled: (userId: string, worldId: string) => boolean;
    isS3Configured: () => boolean;
}) {
    const { db, authMiddleware, sessionMedia, sessionMediaLimit, sessionMediaUploadsEnabled, isS3Configured } = deps;
    const sessionMediaRoutes = new Hono<AppEnv>();
    sessionMediaRoutes.use('*', authMiddleware);
    sessionMediaRoutes.use('*', bodyLimit({maxSize:512*1024,onError:c=>c.json({error:'MEDIA_REQUEST_TOO_LARGE',code:'MEDIA_REQUEST_TOO_LARGE'},413)}));
    sessionMediaRoutes.use('*', async (c, next) => {
        c.header('Cache-Control', 'private, no-store');
        await next();
    });
    sessionMediaRoutes.onError((error, c) => {
        if (error instanceof MediaError)
            return c.json({ error: error.code, code: error.code }, error.status);
        if (error instanceof z.ZodError)
            return c.json({ error: 'MEDIA_INVALID_REQUEST', code: 'MEDIA_INVALID_REQUEST' }, 400);
        // Signed URLs and private metadata must not be included in logs.
        console.error('[session-media] request failed');
        return c.json({ error: 'MEDIA_UNAVAILABLE', code: 'MEDIA_UNAVAILABLE' }, 503);
    });
    const offsetOf = (raw: string | undefined) => Math.max(0, Math.min(100000, Number.parseInt(raw ?? '0', 10) || 0));
    const revisionBody = z.object({ revision: z.number().int().positive() });
    sessionMediaRoutes.get('/', async (c) => {
        const userId = c.get('user').id;
        if (!await sessionMedia.isReady())
            return c.json({ data: { items: [], hasMore: false, sessions: [], configured: false, storage: { ...await sessionMedia.usage(userId), limit: await sessionMediaLimit(userId) } } });
        const list = await sessionMedia.ownList(userId, { offset: offsetOf(c.req.query('offset')), sessionId: c.req.query('sessionId'), filter: c.req.query('filter'), order: c.req.query('order') });
        const sessions = await mediaRows(db, sql `SELECT DISTINCT s.id,COALESCE(s.name,w.name) AS name FROM play_sessions s JOIN worlds w ON w.id=s.world_id
    JOIN session_media_refs r ON r.session_id=s.id WHERE s.user_id=${userId} AND r.removed_at IS NULL ORDER BY name LIMIT 500`);
        return c.json({ data: { ...list, sessions, configured: true, storage: { ...await sessionMedia.usage(userId), limit: await sessionMediaLimit(userId) } } });
    });
    sessionMediaRoutes.get('/session/:sessionId', async (c) => {
        const userId = c.get('user').id, sessionId = c.req.param('sessionId');
        const session = await sessionMedia.ownSession(db, userId, sessionId);
        return c.json({ data: { ...await sessionMedia.scopeList({ sessionId }, offsetOf(c.req.query('offset'))), uploadsEnabled: isS3Configured() && await sessionMedia.isReady() && sessionMediaUploadsEnabled(userId, session.world_id) } });
    });
    sessionMediaRoutes.post('/uploads', async (c) => {
        const body = z.object({ id: z.string().uuid(), sessionId: z.string().min(1), entryId: z.string().min(1).max(100), filename: z.string().min(1).max(200), contentType: z.string(), size: z.number().int().positive(), metadata: z.record(z.unknown()).optional() }).parse(await c.req.json());
        const userId = c.get('user').id;
        const session = await sessionMedia.ownSession(db, userId, body.sessionId);
        if (!isS3Configured() || !sessionMediaUploadsEnabled(userId, session.world_id))
            throw new MediaError('MEDIA_UPLOADS_PAUSED', 503);
        return c.json({ data: await sessionMedia.reserve(userId, await sessionMediaLimit(userId), body) });
    });
    sessionMediaRoutes.post('/uploads/:id/complete', async (c) => {
        const userId = c.get('user').id;
        // In-flight uploads may finish after the rollout flag is disabled.
        return c.json({ data: await sessionMedia.complete(userId, c.req.param('id'), await sessionMediaLimit(userId)) });
    });
    sessionMediaRoutes.delete('/session/:sessionId/entries/:entryId', async (c) => {
        const { version } = z.object({ version: z.number().int().positive() }).parse(await c.req.json());
        return c.json({ data: await sessionMedia.unlink(c.get('user').id, c.req.param('sessionId'), c.req.param('entryId'), version) });
    });
    sessionMediaRoutes.patch('/session/:sessionId/gallery', async (c) => {
        const body = z.object({ changes: z.array(z.object({ entryId: z.string().max(100), version: z.number().int().positive(), metadata: z.record(z.unknown()).optional(), remove: z.boolean().optional() })).max(100), document: z.object({ version: z.number().int().nonnegative(), value: z.record(z.unknown()) }).optional() }).parse(await c.req.json());
        await sessionMedia.editGallery(c.get('user').id, c.req.param('sessionId'), body.changes, body.document);
        return c.json({ data: { saved: true } });
    });
    sessionMediaRoutes.post('/session/:sessionId/entry-status', async (c) => {
        const { ids } = z.object({ ids: z.array(z.string().max(100)).max(100) }).parse(await c.req.json());
        const sessionId = c.req.param('sessionId');
        await sessionMedia.ownSession(db, c.get('user').id, sessionId);
        if (!await sessionMedia.isReady())
            return c.json({ data: { known: [] } });
        const rows = await mediaRows<{
            entry_id: string;
        }>(db, sql `SELECT DISTINCT entry_id FROM session_media_refs WHERE session_id=${sessionId} AND entry_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`);
        return c.json({ data: { known: rows.map(r => r.entry_id) } });
    });
    sessionMediaRoutes.get('/:id', async (c) => c.json({ data: await sessionMedia.detail(c.get('user').id, c.req.param('id')) }));
    sessionMediaRoutes.delete('/:id', async (c) => {
        const body = revisionBody.parse(await c.req.json());
        return c.json({ data: await sessionMedia.remove(c.get('user').id, c.req.param('id'), body.revision) });
    });
    return sessionMediaRoutes;
}
