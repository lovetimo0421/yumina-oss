import test from "node:test";
import assert from "node:assert/strict";
import { adaptOncinGalleryFiles, createOncinCloudGallery, isOncinGalleryKey } from "./oncin-cloud-gallery";
import type { SessionImage, SessionImagePage } from "@/lib/session-media";
test('recognizes the gallery format in any world and preserves adjacent helpers', () => {
    const source = `const prefix = 'oncin:gallery:v3:';
      function oswGalleryEmptyData() { return {}; }
      function oswNormalizeGalleryPayload(x) { return x; }
      function oswUseGalleryStore(api) { throw new Error('old hook'); }
      function adjacentHelper() { return 42; }`;
    const files = { 'index.tsx': source };
    const patched = adaptOncinGalleryFiles('new-world', files)!;
    const run = new Function(`${patched['index.tsx']}; return [oswUseGalleryStore({__useLegacyGallery: opts => opts.normalize({works:true})}), adjacentHelper()];`);
    assert.deepEqual(run(), [{works:true}, 42]);
    assert.equal(adaptOncinGalleryFiles('new-world', patched), patched);
    assert.equal(files['index.tsx'], source);
    const unrelated = { 'index.tsx': 'function oswUseGalleryStore(api) {}' };
    assert.equal(adaptOncinGalleryFiles('any', unrelated), unrelated);
});
function harness() {
    const rows: SessionImage[] = [];
    const known = new Set<string>();
    let document = { value: {} as Record<string, unknown>, version: 0 };
    let uploads = 0, failUploads = false, deny = false;
    let afterWrite: (() => void) | undefined;
    const changes: {
        entryId: string;
        remove?: boolean;
    }[] = [];
    const dependencies = {
        list: async (): Promise<SessionImagePage> => { if (deny)
            throw new Error('not owner'); return { items: structuredClone(rows), hasMore: false, document: structuredClone(document), uploadsEnabled: true, initialized: !!known.size }; },
        upload: async (_sid: string, _file: Blob, opts?: {
            entryId?: string;
            metadata?: Record<string, unknown>;
        }) => {
            if (failUploads)
                throw new Error('offline');
            uploads++;
            const entryId = opts!.entryId!;
            known.add(entryId);
            rows.push({ id: entryId, entryId, filename: 'image', metadata: opts!.metadata!, version: 1, sizeBytes: 50, url: `https://example.test/${entryId}`, thumbnailUrl: null, deleted: false });
            return { mediaId: entryId, entryId };
        },
        request: async <T>(path: string, init?: RequestInit): Promise<T> => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            if (path.endsWith('entry-status'))
                return { known: body.ids.filter((id: string) => known.has(id)) } as T;
            if (path.endsWith('gallery')) {
                changes.push(...body.changes);
                if (body.document) {
                    assert.equal(body.document.version, document.version);
                    document = { value: body.document.value, version: document.version + 1 };
                }
                for (const change of body.changes) {
                    const row = rows.find(r => r.entryId === change.entryId)!;
                    assert.equal(row.version, change.version);
                    if (change.remove)
                        rows.splice(rows.indexOf(row), 1);
                    else {
                        row.metadata = change.metadata;
                        row.version++;
                    }
                }
                afterWrite?.();
                return { saved: true } as T;
            }
            throw new Error('unexpected request');
        },
    };
    return { rows, known, changes, dependencies, get uploads() { return uploads; }, set fail(value: boolean) { failUploads = value; }, set deny(value: boolean) { deny = value; }, set afterWrite(callback: (() => void) | undefined) { afterWrite = callback; }, get document() { return document; }, set document(value: typeof document) { document = value; } };
}
const local = JSON.stringify({ version: 2, items: [{ id: 'image:one', url: 'data:image/png;base64,YWJj', title: 'One', collectionIds: ['c'] }], collections: [{ id: 'c', name: 'Scenes' }], primaryCharacterPortraits: {}, primaryPlaceCovers: {}, collectionCoverIds: {}, campaignCoverId: 'image:one' });
test('migration verifies the current session before reading local data', async () => {
    const h = harness();
    h.deny = true;
    let touched = false;
    const adapter = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    await assert.rejects(adapter.get(() => { touched = true; return local; }));
    assert.equal(touched, false);
    assert.equal(isOncinGalleryKey('another-world', 'oncin:gallery:v2:session', 'session'), true);
    assert.equal(isOncinGalleryKey('27483dff-e14f-49ec-864c-37bd85d7d9c4', 'oncin:gallery:v2:other', 'session'), false);
});
test('migrates per item, retains grouping, and does not resurrect removed images', async () => {
    const h = harness();
    const a = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    const payload = JSON.parse(await a.get(() => local));
    assert.equal(h.uploads, 1);
    assert.equal(payload.items[0].url, 'https://example.test/image:one');
    assert.equal(payload.collections[0].name, 'Scenes');
    h.rows.splice(0);
    const b = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    const after = JSON.parse(await b.get(() => local));
    assert.equal(after.items.length, 0);
    assert.equal(h.uploads, 1);
});
test('an old device never removes images added by another device', async () => {
    const h = harness();
    const a = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    const payload = JSON.parse(await a.get(() => local));
    h.rows.push({ id: 'remote', entryId: 'remote', filename: 'remote', metadata: { legacy: 'oncin-v2', item: { id: 'remote', title: 'Remote' } }, version: 1, sizeBytes: 5, url: 'https://example.test/remote', thumbnailUrl: null, deleted: false });
    payload.items[0].title = 'Edited';
    await a.set(JSON.stringify(payload));
    payload.items[0].title = 'Edited twice';
    await a.set(JSON.stringify(payload));
    assert.ok(h.rows.some(r => r.entryId === 'remote'));
    assert.ok(!h.changes.some(r => r.entryId === 'remote'));
});
test('saving never adopts unseen versions from a concurrent device', async () => {
    const h = harness();
    const a = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    const payload = JSON.parse(await a.get(() => local));
    h.afterWrite = () => {
        h.afterWrite = undefined;
        h.rows[0]!.metadata = { legacy: 'oncin-v2', item: { ...h.rows[0]!.metadata.item as object, title: 'Other device' } };
        h.rows[0]!.version++;
    };
    payload.items[0].title = 'My edit';
    await a.set(JSON.stringify(payload));
    payload.items[0].favorite = true;
    await assert.rejects(a.set(JSON.stringify(payload)));
    assert.equal((h.rows[0]!.metadata.item as { title: string }).title, 'Other device');
});

test('unseen collection edits also retain their old conflict version', async () => {
    const h = harness();
    const a = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    const payload = JSON.parse(await a.get(() => local));
    h.afterWrite = () => {
        h.afterWrite = undefined;
        h.document = { version: h.document.version + 1, value: { ...h.document.value, collections: [{ id: 'c', name: 'Other device' }] } };
    };
    payload.items[0].title = 'My edit';
    await a.set(JSON.stringify(payload));
    payload.campaignCoverId = '';
    await assert.rejects(a.set(JSON.stringify(payload)));
    assert.deepEqual(h.document.value.collections, [{ id: 'c', name: 'Other device' }]);
});

test('gallery edits do not unlink images owned by other SDK features', async () => {
    const h = harness();
    h.rows.push({ id: 'other', entryId: 'other', filename: 'other', metadata: { feature: 'avatar' }, version: 1, sizeBytes: 5, url: 'https://example.test/other', thumbnailUrl: null, deleted: false });
    const a = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    const payload = JSON.parse(await a.get(() => local));
    assert.equal(payload.items.length, 1);
    payload.items[0].title = 'My edit';
    await a.set(JSON.stringify(payload));
    assert.ok(h.rows.some(row => row.entryId === 'other'));
    assert.ok(!h.changes.some(change => change.entryId === 'other'));
});

test('failed migration retains local image data and reports incomplete persistence', async () => {
    const h = harness();
    h.fail = true;
    let warnings = 0;
    const a = createOncinCloudGallery('session', undefined, () => warnings++, h.dependencies);
    const payload = JSON.parse(await a.get(() => local));
    assert.equal(payload.items[0].url, 'data:image/png;base64,YWJj');
    assert.equal(payload.collections[0].name, 'Scenes');
    assert.ok(warnings > 0);
    await assert.rejects(a.set(JSON.stringify(payload)), /offline/);
});
test('a replay never reads the viewer browser cache or writes to the source save', async () => {
    const h = harness();
    const a = createOncinCloudGallery('', 'share', undefined, h.dependencies);
    await a.get(() => { throw new Error('must not read local'); });
    await assert.rejects(a.set(local), /read-only/);
});

test('read-only session views never migrate, even when uploads are enabled', async () => {
    const h = harness();
    const a = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    let touched = false;
    await a.get(() => { touched = true; return local; }, false);
    assert.equal(touched, false);
    assert.equal(h.uploads, 0);
    assert.equal(h.document.version, 0);
});

test('signed URL refresh never adopts unseen metadata versions', async () => {
    const h = harness();
    const a = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    const data = JSON.parse(await a.get(() => local));
    h.rows[0]!.url = 'https://example.test/fresh';
    h.rows[0]!.metadata = { legacy: 'oncin-v2', item: {...h.rows[0]!.metadata.item as object, title: 'Other device'} };
    h.rows[0]!.version++;
    const urls = await a.refresh();
    data.items[0].url = urls[data.items[0].id];
    data.items[0].title = 'Local edit';
    await assert.rejects(a.set(JSON.stringify(data)));
    assert.equal(h.rows[0]!.metadata.item && (h.rows[0]!.metadata.item as {title: string}).title, 'Other device');
});

test('normalizer transport fields do not force writes across a large gallery', async () => {
    const h = harness();
    for (let i = 0; i < 120; i++) h.rows.push({id: `i${i}`, entryId: `i${i}`, filename: 'image', metadata: {legacy: 'oncin-v2', item: {id: `i${i}`, title: 'Image'}}, version: 1, sizeBytes: 3, url: `https://example.test/${i}`, thumbnailUrl: null, deleted: false});
    const a = createOncinCloudGallery('session', undefined, undefined, h.dependencies);
    const data = JSON.parse(await a.get(() => null));
    for (const item of data.items) Object.assign(item, {assetId: '', assetChars: 0, assetHash: '', _assetIntegrityUrl: item.url});
    data.items[0].title = 'Edited';
    await a.set(JSON.stringify(data));
    assert.equal(h.changes.length, 1);
    assert.ok(!JSON.stringify(h.rows[0]!.metadata).includes('_assetIntegrityUrl'));
});

test('unrelated shared media does not hide an unmigrated published variable gallery', async () => {
    const h = harness();
    h.known.add('avatar');
    h.rows.push({id: 'avatar', entryId: 'avatar', filename: 'avatar', metadata: {purpose: 'avatar'}, version: 1, sizeBytes: 3, url: 'https://example.test/avatar', thumbnailUrl: null, deleted: false});
    const a = createOncinCloudGallery('', 'share', undefined, h.dependencies, () => local);
    const data = JSON.parse(await a.get(() => { throw new Error('must not read viewer cache'); }));
    assert.equal(data.items[0].id, 'image:one');
    assert.equal(h.uploads, 0);
    h.document = {value: {legacyGalleryVersion: 1}, version: 1};
    assert.equal(JSON.parse(await a.get(() => local)).items.length, 0, 'an emptied cloud gallery never revives the old variable snapshot');
});
