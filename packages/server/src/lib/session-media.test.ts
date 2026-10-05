import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import sharp from "sharp";
import { sql } from "drizzle-orm";
import { SESSION_MEDIA_DDL } from "../db/session-media-ddl.js";
import type { DrizzleDB } from "../db/index.js";
import { createSessionMediaService, mediaPrefix } from "./session-media-service.js";
import { MEDIA_RESERVATION, prepareSessionImage } from "./session-media-image.js";
import { isPublicCdnKey } from "./cdn-key-policy.js";
import { createSessionMediaRoutes } from "../routes/session-media-router.js";
import type { SessionUser } from "./types.js";
test("private media: ownership, atomic reservations, immutable snapshots, retries and cleanup", async () => {
    const pg = new PGlite();
    try {
        await pg.exec(`CREATE TABLE "user" (id text PRIMARY KEY);
      CREATE TABLE user_assets(id text PRIMARY KEY,user_id text,size_bytes bigint,url text);
      CREATE TABLE worlds(id text PRIMARY KEY,name text);
      CREATE TABLE play_sessions(id text PRIMARY KEY,user_id text,world_id text,name text,parent_session_id text,branched_from_message_id text);
      CREATE TABLE messages(id text PRIMARY KEY,session_id text,created_at timestamp);
      CREATE TABLE checkpoints(id text PRIMARY KEY,session_id text,name text);
      CREATE TABLE shared_playthroughs(id text PRIMARY KEY,source_session_id text,sharer_user_id text,title text);
      INSERT INTO "user" VALUES ('alice'),('bob');
      INSERT INTO worlds VALUES ('world','World');
      INSERT INTO play_sessions VALUES ('save','alice','world','Save',NULL,NULL),('bob-save','bob','world','Bob',NULL,NULL);`);
        const db = drizzle(pg) as unknown as DrizzleDB;
        const unconfigured = createSessionMediaService(db, {
            signUpload: async () => '', signRead: async () => '', read: async () => Buffer.alloc(0),
            write: async () => {}, remove: async () => {},
        });
        // Legacy uploads must still finish inside their transaction before rollout.
        assert.deepEqual(await db.transaction(tx => unconfigured.usage('alice', tx)), { used: 0, mediaBytes: 0, reserved: 0 });
        await pg.exec(SESSION_MEDIA_DDL);
        // Installing twice must preserve all tables and not duplicate triggers.
        await pg.exec(SESSION_MEDIA_DDL);
        const objects = new Map<string, Buffer>();
        let failDelete = false;
        let failWrite = false;
        const service = createSessionMediaService(db, {
            signUpload: async (key) => key, signRead: async (key) => `signed:${key}`,
            read: async (key) => { const value = objects.get(key); if (!value)
                throw new Error('missing'); return value; },
            write: async (key, data) => { objects.set(key, data); if(failWrite){failWrite=false;throw new Error('connection lost after PUT');} }, remove: async (key) => { if (failDelete)
                throw new Error('offline'); objects.delete(key); },
        });
        const image = await sharp({ create: { width: 30, height: 20, channels: 4, background: '#123456aa' } }).png().toBuffer();
        const quota = 100 * 1024 * 1024;
        const request = (entryId: string) => ({ id: randomUUID(), sessionId: 'save', entryId, filename: 'map.png', contentType: 'image/png', size: image.length, metadata: { title: 'Map', a: 1 } });
        const first = request('one');
        await assert.rejects(service.reserve('alice', quota, { ...first, metadata: { purpose: 'creative-asset' } }), /MEDIA_INVALID_METADATA/);
        await assert.rejects(service.reserve('bob', quota, first), /MEDIA_NOT_FOUND/);
        const reserved = await service.reserve('alice', quota, first);
        assert.ok(reserved.uploadUrl!.startsWith('private-session-media/'));
        objects.set(reserved.uploadUrl!, image);
        const reservedAgain = await service.reserve('alice', quota, { ...first, metadata: { a: 1, title: 'Map' } });
        assert.equal(reservedAgain.id, reserved.id);
        const before = await service.usage('alice');
        assert.equal(before.reserved, image.length + MEDIA_RESERVATION);
        const complete = await service.complete('alice', first.id, quota);
        assert.deepEqual(await service.complete('alice', first.id, quota), complete);
        assert.equal((await service.scopeList({ sessionId: 'save' })).items.length, 1);
        await assert.rejects(service.detail('bob', complete.mediaId!), /MEDIA_NOT_FOUND/);
        const initial = await service.detail('alice', complete.mediaId!);
        const routes = createSessionMediaRoutes({ db, sessionMedia: service, sessionMediaLimit: async () => quota, sessionMediaUploadsEnabled: () => false, isS3Configured: () => true,
            authMiddleware: async (c, next) => { const id = c.req.header('x-test-user'); if (!id)
                return c.json({ error: 'Unauthorized' }, 401); c.set('user', { id } as SessionUser); await next(); } });
        assert.equal((await routes.request('/session/save')).status, 401);
        assert.equal((await routes.request('/session/save', { headers: { 'x-test-user': 'bob' } })).status, 404);
        assert.equal((await routes.request(`/${complete.mediaId}`, { headers: { 'x-test-user': 'bob' } })).status, 404);
        const read = await routes.request('/session/save', { headers: { 'x-test-user': 'alice' } });
        assert.equal(read.status, 200);
        assert.equal(read.headers.get('cache-control'), 'private, no-store');
        assert.equal((await read.json() as {data:{uploadsEnabled:boolean}}).data.uploadsEnabled, false, 'kill switch preserves existing reads');
        assert.equal((await routes.request('/uploads', { method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: JSON.stringify(request('paused')) })).status, 503);
        await service.editGallery('alice', 'save', [], { version: 0, value: { campaignCoverId: 'one' } });
        await pg.exec(`INSERT INTO checkpoints VALUES ('checkpoint','save','Checkpoint'); INSERT INTO shared_playthroughs VALUES ('share','save','alice','Shared');`);
        assert.equal((await service.scopeList({ shareId: 'share' })).items.length, 1);
        assert.deepEqual((await service.scopeList({ shareId: 'share' })).document?.value, { campaignCoverId: 'one' });
        await assert.rejects(service.editGallery('alice', 'save', [{ entryId: 'one', version: 999, remove: true }], { version: 1, value: { campaignCoverId: '' } }), /MEDIA_REFERENCE_CONFLICT/);
        assert.deepEqual((await service.scopeList({ sessionId: 'save' })).document?.value, { campaignCoverId: 'one' }, 'a conflicting batch cannot partly overwrite gallery metadata');
        await assert.rejects(service.remove('alice', complete.mediaId!, initial.revision), /MEDIA_REFERENCE_CONFLICT/);
        const ref = (await service.scopeList({ sessionId: 'save' })).items[0]!;
        await service.unlink('alice', 'save', 'one', ref.version);
        assert.equal((await service.scopeList({ sessionId: 'save' })).items.length, 0);
        assert.equal((await service.scopeList({ shareId: 'share' })).items.length, 1);
        const second = request('two');
        const secondReservation = await service.reserve('alice', quota, second);
        objects.set(secondReservation.uploadUrl!, image);
        assert.equal((await service.complete('alice', second.id, quota)).mediaId, complete.mediaId, 'same-account content dedup');
        assert.equal((await service.scopeList({ shareId: 'share' })).items.length, 1, 'share does not acquire later additions');
        await db.transaction(tx => service.restore(tx, 'alice', 'save', 'checkpoint'));
        const restored = await service.scopeList({ sessionId: 'save' });
        assert.equal(restored.items.length, 1);
        assert.equal(restored.items[0]?.entryId, 'one');
        assert.ok(restored.items[0]!.version > ref.version);
        assert.deepEqual(restored.document?.value, { campaignCoverId: 'one' });
        await assert.rejects(service.unlink('alice', 'save', 'one', ref.version), /MEDIA_REFERENCE_CONFLICT/);
        // A branch from an earlier message uses historical membership, not today's gallery.
        await pg.exec(`INSERT INTO messages VALUES ('past','save',now() AT TIME ZONE 'UTC');
      INSERT INTO play_sessions VALUES ('branch','alice','world','Branch','save','past');
      INSERT INTO play_sessions VALUES ('foreign','bob','world','Foreign','save','past');`);
        assert.equal((await service.scopeList({ sessionId: 'branch' })).items.length, 1);
        assert.equal((await service.scopeList({ sessionId: 'foreign' })).items.length, 0);
        const retryRequest=request('retry');
        const retryReservation=await service.reserve('alice',quota,retryRequest);
        objects.set(retryReservation.uploadUrl!,image);
        failWrite=true;
        await assert.rejects(service.complete('alice',retryRequest.id,quota),/MEDIA_PROCESSING_FAILED/);
        assert.ok(!(await service.scopeList({sessionId:'save'})).items.some(item=>item.entryId==='retry'),'failed object writes never bind an entry');
        assert.equal((await service.complete('alice',retryRequest.id,quota)).mediaId,complete.mediaId);
        // Large legacy galleries still commit atomically. A conflict at the end
        // of a >100-item batch must roll back every earlier removal.
        await db.execute(sql`INSERT INTO session_media_refs(id,media_id,session_id,entry_id,metadata,version)
          SELECT 'large-ref-'||n,${complete.mediaId!},'save','large-'||n,'{}'::jsonb,1 FROM generate_series(1,120) n`);
        const largeChanges = Array.from({length: 120}, (_, i) => ({entryId: `large-${i + 1}`, version: 1, remove: true}));
        const largePatch = (changes: typeof largeChanges) => routes.request('/session/save/gallery', {
          method: 'PATCH', headers: {'x-test-user': 'alice', 'content-type': 'application/json'}, body: JSON.stringify({changes}),
        });
        assert.equal((await largePatch([...largeChanges, {entryId: 'missing', version: 1, remove: true}])).status, 409);
        assert.equal((await pg.query<{count: number}>(`SELECT count(*)::int AS count FROM session_media_refs WHERE id LIKE 'large-ref-%' AND removed_at IS NULL`)).rows[0]!.count, 120);
        assert.equal((await largePatch(largeChanges)).status, 200);
        assert.equal((await pg.query<{count: number}>(`SELECT count(*)::int AS count FROM session_media_refs WHERE id LIKE 'large-ref-%' AND removed_at IS NULL`)).rows[0]!.count, 0);
        // Exactly one of two concurrent reservations can claim the remaining room.
        const current = await service.usage('alice');
        const limit = current.used + current.reserved + image.length + MEDIA_RESERVATION;
        const races = await Promise.allSettled([service.reserve('alice', limit, request('race1')), service.reserve('alice', limit, request('race2'))]);
        assert.equal(races.filter(x => x.status === 'fulfilled').length, 1);
        const latest = await service.detail('alice', complete.mediaId!);
        failDelete = true;
        assert.equal((await service.remove('alice', complete.mediaId!, latest.revision)).pending, true);
        assert.equal((await service.scopeList({ shareId: 'share' })).items[0]?.url, null, 'revoked immediately for new grants');
        assert.ok((await service.usage('alice')).used > 0, 'failed cleanup still consumes quota');
        failDelete = false;
        await service.remove('alice', complete.mediaId!, latest.revision);
        assert.equal((await service.usage('alice')).used, 0);
        await db.execute(sql `UPDATE session_media_uploads SET expires_at=now()-interval '1 hour'`);
        await service.sweep();
        assert.equal((await service.usage('alice')).reserved, 0);
        assert.equal(objects.size, 0, 'originals and deduplicated attempt files are cleaned');
        const tempKey = mediaPrefix('alice') + 'pending/failed-creative';
        const orphanKey = `users/alice/registered/${createHash('sha256').update(tempKey).digest('hex')}`;
        objects.set(tempKey, image);
        objects.set(orphanKey, image);
        await db.execute(sql`INSERT INTO session_media_uploads(id,user_id,entry_id,filename,content_type,input_bytes,reserved_bytes,metadata,temp_key,expires_at)
          VALUES(${randomUUID()},'alice','creative','map.png','image/png',${image.length},${image.length},'{"purpose":"creative-asset"}',${tempKey},now()-interval '1 hour')`);
        await service.sweep();
        assert.equal(objects.size, 0, 'a copied creative asset whose registration failed must not leak storage');
        assert.ok(!mediaPrefix('alice').startsWith('users/'));
        assert.equal(isPublicCdnKey(mediaPrefix('alice') + 'objects/file/main.webp'), false);
        assert.equal(isPublicCdnKey('users/alice/../../private-session-media/alice/file'), false);
        assert.equal(isPublicCdnKey('users/alice/image/public.png'), true);
    }
    finally {
        await pg.close();
    }
});
test("nested branches retain inherited image and collection history without future source edits", async () => {
    const pg = new PGlite();
    try {
        await pg.exec(`CREATE TABLE "user" (id text PRIMARY KEY);
          CREATE TABLE play_sessions(id text PRIMARY KEY,user_id text,parent_session_id text,branched_from_message_id text,world_id text);
          CREATE TABLE messages(id text PRIMARY KEY,session_id text,created_at timestamp);
          CREATE TABLE checkpoints(id text PRIMARY KEY,session_id text);
          CREATE TABLE shared_playthroughs(id text PRIMARY KEY,source_session_id text,sharer_user_id text);
          INSERT INTO "user" VALUES ('alice');
          INSERT INTO play_sessions VALUES ('a','alice',NULL,NULL);`);
        await pg.exec(SESSION_MEDIA_DDL);
        await pg.exec(`INSERT INTO session_media(id,user_id,filename,hash,object_key,thumbnail_key,size_bytes,width,height)
          SELECT id,'alice',id,id,id,id,10,1,1 FROM (VALUES ('old'),('fork'),('future')) AS files(id);
          INSERT INTO session_media_refs(id,media_id,session_id,entry_id,metadata,version,added_at,removed_at) VALUES
          ('r1','old','a','portrait','{"title":"Old"}',1,'2026-01-01','2026-01-03'),
          ('r2','fork','a','portrait','{"title":"At fork"}',2,'2026-01-03','2026-01-05'),
          ('r3','future','a','portrait','{"title":"Future"}',3,'2026-01-05',NULL);
          INSERT INTO session_media_documents(id,session_id,value,version,added_at,removed_at) VALUES
          ('d1','a','{"collection":"Old"}',1,'2026-01-01','2026-01-03'),
          ('d2','a','{"collection":"At fork"}',2,'2026-01-03','2026-01-05'),
          ('d3','a','{"collection":"Future"}',3,'2026-01-05',NULL);
          INSERT INTO messages VALUES ('a-early','a','2026-01-02'),('a-fork','a','2026-01-04');
          INSERT INTO play_sessions VALUES ('b','alice','a','a-fork');
          -- The real branch route preserves original message creation times.
          INSERT INTO messages SELECT 'b-'||id,'b',created_at FROM messages WHERE session_id='a';
          INSERT INTO play_sessions VALUES ('c','alice','b','b-a-fork'),('c-early','alice','b','b-a-early');`);
        const service = createSessionMediaService(drizzle(pg) as unknown as DrizzleDB, {
            signUpload: async () => '', signRead: async key => `signed:${key}`,
            read: async () => Buffer.alloc(0), write: async () => {}, remove: async () => {},
        });
        for (const id of ['b', 'c']) {
            const gallery = await service.scopeList({sessionId: id});
            assert.deepEqual(gallery.items.map(item => [item.id, item.metadata]), [['fork', {title: 'At fork'}]]);
            assert.deepEqual(gallery.document?.value, {collection: 'At fork'});
        }
        const earlier = await service.scopeList({sessionId: 'c-early'});
        assert.deepEqual(earlier.items.map(item => [item.id, item.metadata]), [['old', {title: 'Old'}]]);
        assert.deepEqual(earlier.document?.value, {collection: 'Old'});
        // Preserve history but clip source changes after the fork point.
        const history = await pg.query<{media_id: string; removed: boolean}>(
          `SELECT media_id,removed_at IS NOT NULL AS removed FROM session_media_refs WHERE session_id='b' ORDER BY version`);
        assert.deepEqual(history.rows, [{media_id:'old',removed:true},{media_id:'fork',removed:false}]);
        await service.editGallery('alice', 'b', [{entryId:'portrait',version:2,metadata:{title:'B edit'}}], {version:2,value:{collection:'B edit'}});
        await pg.exec(`INSERT INTO checkpoints VALUES ('cp','b');
          INSERT INTO shared_playthroughs VALUES ('share','b','alice');
          INSERT INTO play_sessions VALUES ('after-edit','alice','b','b-a-fork');`);
        const historicalBranch = await service.scopeList({sessionId:'after-edit'});
        assert.deepEqual(historicalBranch.items[0]?.metadata,{title:'At fork'});
        assert.deepEqual(historicalBranch.document?.value,{collection:'At fork'});
        const share = await service.scopeList({shareId:'share'});
        assert.equal(share.items.length,1,'shares snapshot current state without historical duplicates');
        assert.deepEqual(share.items[0]?.metadata,{title:'B edit'});
        assert.deepEqual(share.document?.value,{collection:'B edit'});
        const snapshot = await pg.query<{count:number}>(`SELECT count(*)::int AS count FROM session_media_refs WHERE checkpoint_id='cp'`);
        assert.equal(snapshot.rows[0]?.count,1,'checkpoints snapshot current state without historical duplicates');
    } finally {
        await pg.close();
    }
});
test("image processing rejects false formats and strips metadata while preserving alpha", async () => {
    await assert.rejects(prepareSessionImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')));
    await assert.rejects(prepareSessionImage(Buffer.from('not an image')));
    const original = await sharp({ create: { width: 3000, height: 500, channels: 4, background: '#aabbcc80' } }).withMetadata().png().toBuffer();
    const result = await prepareSessionImage(original);
    const decoded = await sharp(result.main).metadata();
    assert.equal(decoded.width, 2048);
    assert.equal(decoded.hasAlpha, true);
    assert.equal(decoded.exif, undefined);
    assert.ok(result.thumbnail.length < 128 * 1024);
});
