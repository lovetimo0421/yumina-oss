import test from "node:test";
import assert from "node:assert/strict";
import { adaptOncinGalleryFiles, createOncinCloudGallery, isOncinGalleryKey } from "./oncin-cloud-gallery";
import type { SessionImage, SessionImagePage } from "@/lib/session-media";
test('legacy hook refreshes signed URLs and removes its timer on unmount', async () => {
    const files = { 'index.tsx': `function oswUseGalleryStore(api) {
      var data = {}, setData = api.received;
      var warnedRef = React.useRef(false);
      var lastPersistedRef = React.useRef('{}'), writeChainRef = React.useRef(Promise.resolve()), loadSeqRef = React.useRef(1);
      function warnOnce() { throw new Error('unexpected refresh failure'); }
      React.useEffect(function () {
        var cancelled = false, seq = 1, storageKey = 'gallery';
        return function () { cancelled = true; };
      }, []);
    }
    function oswVisualEntryKind() {}` };
    assert.equal(adaptOncinGalleryFiles('another-world', files), files);
    const patched = adaptOncinGalleryFiles('27483dff-e14f-49ec-864c-37bd85d7d9c4', files)!;
    let refresh!: () => void, cleanup!: () => void, received: unknown, reads = 0, cleared = false;
    const hook = new Function('React', 'window', 'setInterval', 'clearInterval', 'oswGalleryPayloadForStorage', 'oswNormalizeGalleryPayload', `${patched['index.tsx']}; return oswUseGalleryStore;`)(
        { useRef: (current: unknown) => ({ current }), useEffect: (effect: () => () => void) => { cleanup = effect(); } },
        { addEventListener() {}, removeEventListener() {} },
        (callback: () => void) => { refresh = callback; return 1; }, () => { cleared = true; }, JSON.stringify, (x: unknown) => x,
    );
    hook({ received: (value: unknown) => { received = value; }, storage: { get: async () => { reads++; return '{"fresh":true}'; } } });
    refresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(received, { fresh: true });
    assert.equal(reads, 1);
    cleanup();
    refresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.ok(cleared);
    assert.ok(!files['index.tsx'].includes('refreshCloudGallery'));
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
    assert.equal(isOncinGalleryKey('another-world', 'oncin:gallery:v2:session', 'session'), false);
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
