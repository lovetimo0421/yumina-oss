import { listSessionImages as defaultList, uploadSessionImage as defaultUpload, mediaRequest as defaultRequest, type SessionImage, type SessionImagePage } from "@/lib/session-media";
const WORLDS = new Set(['27483dff-e14f-49ec-864c-37bd85d7d9c4', '6c559d1d-7dd0-4868-a360-d31d40ea3cd0', '271115e1-7522-49aa-a194-9acfe8a13c4e']);
export const isOncinGalleryWorld = (id: string) => WORLDS.has(id);
/** Compatibility patch for the verified hook only; never edits the published card. */
export function adaptOncinGalleryFiles(worldId: string, files: Record<string, string> | undefined) {
    if (!files || !WORLDS.has(worldId))
        return files;
    let changed = false;
    const next = { ...files };
    for (const [name, source] of Object.entries(files)) {
        const start = source.indexOf('function oswUseGalleryStore(api) {');
        const end = source.indexOf('function oswVisualEntryKind(', start);
        if (start < 0 || end < 0)
            continue;
        const hook = source.slice(start, end);
        const cleanup = 'return function () { cancelled = true; };';
        if (!hook.includes(cleanup) || !hook.includes('var warnedRef = React.useRef(false);'))
            continue;
        const patched = hook.replace('var warnedRef = React.useRef(false);', 'var warnedRef = React.useRef(false);\n  var cloudDataRef = React.useRef(data);\n  cloudDataRef.current = data;').replace(cleanup, `
    function refreshCloudGallery() {
      if (cancelled || oswGalleryPayloadForStorage(cloudDataRef.current) !== lastPersistedRef.current) return;
      var before = lastPersistedRef.current;
      var chain = writeChainRef.current;
      Promise.resolve(chain).then(function () { return api.storage.get(storageKey); }).then(function (raw) {
        if (cancelled || loadSeqRef.current !== seq || chain !== writeChainRef.current ||
            before !== lastPersistedRef.current || oswGalleryPayloadForStorage(cloudDataRef.current) !== before) return;
        var normalized = oswNormalizeGalleryPayload(raw ? JSON.parse(raw) : {});
        lastPersistedRef.current = oswGalleryPayloadForStorage(normalized);
        setData(normalized);
      }).catch(function () { warnOnce(); });
    }
    var refreshTimer = setInterval(refreshCloudGallery, 240000);
    window.addEventListener("focus", refreshCloudGallery);
    return function () { cancelled = true; clearInterval(refreshTimer); window.removeEventListener("focus", refreshCloudGallery); };
`);
        next[name] = source.slice(0, start) + patched + source.slice(end);
        changed = true;
    }
    return changed ? next : files;
}
export const oncinGallerySessionKey = (sessionId: string, shareId?: string) => sessionId || (shareId ? `media-share:${shareId}` : '');
export function isOncinGalleryKey(worldId: string, key: unknown, sessionId: string, shareId?: string) {
    const sid = oncinGallerySessionKey(sessionId, shareId);
    return !!sid && WORLDS.has(worldId) && key === `oncin:gallery:v2:${sid}`;
}
type Item = Record<string, unknown> & {
    id: string;
    url: string;
};
type Payload = Record<string, unknown> & {
    items: Item[];
};
function parse(raw: string | null): Payload {
    const data = raw ? JSON.parse(raw) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.items && (!Array.isArray(data.items) || data.items.length > 500))
        throw new Error('Invalid gallery data');
    return { ...data, items: (data.items ?? []).filter((item: Item) => item && typeof item.id === 'string' && typeof item.url === 'string') };
}
function documentOf(payload: Payload) {
    return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'items' && key !== 'version'));
}
function mergeMigratingDocument(cloud: Record<string, unknown>, local: Payload, pending: Item[]) {
    if (!Object.keys(cloud).length)
        return documentOf(local);
    const ids = new Set(pending.map(item => item.id));
    const collectionIds = new Set(pending.flatMap(item => Array.isArray(item.collectionIds) ? item.collectionIds : []));
    const oldCollections = Array.isArray(local.collections) ? local.collections as {
        id: string;
    }[] : [];
    const cloudCollections = Array.isArray(cloud.collections) ? cloud.collections as {
        id: string;
    }[] : [];
    const result: Record<string, unknown> = { ...cloud, collections: [...cloudCollections, ...oldCollections.filter(c => collectionIds.has(c.id) && !cloudCollections.some(x => x.id === c.id))] };
    for (const key of ['primaryCharacterPortraits', 'primaryPlaceCovers', 'collectionCoverIds']) {
        const localMap = local[key] && typeof local[key] === 'object' ? local[key] as Record<string, unknown> : {};
        result[key] = { ...Object.fromEntries(Object.entries(localMap).filter(([, id]) => typeof id === 'string' && ids.has(id))), ...cloud[key] as object };
    }
    if (!cloud.campaignCoverId && typeof local.campaignCoverId === 'string' && ids.has(local.campaignCoverId))
        result.campaignCoverId = local.campaignCoverId;
    return result;
}
function metadataOf(item: Item) {
    const { url: _url, ...fields } = item;
    return { legacy: 'oncin-v2', item: fields };
}
function same(a: unknown, b: unknown): boolean {
    if (a === b)
        return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object')
        return false;
    const left = Object.keys(a), right = Object.keys(b);
    return left.length === right.length && left.every(key => key in b && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function inlineImage(url: string): Blob {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match || url.length > 23 * 1024 * 1024)
        throw new Error('Only local JPEG, PNG or WebP images can be migrated');
    const decoded = atob(match[2]!);
    return new Blob([Uint8Array.from(decoded, c => c.charCodeAt(0))], { type: match[1] });
}
async function stableUploadId(sessionId: string, item: Item) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sessionId}:${item.id}:${item.url}`)));
    digest[6] = (digest[6]! & 15) | 64;
    digest[8] = (digest[8]! & 63) | 128;
    const h = [...digest].slice(0, 16).map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Only the verified Oncin v2 format is adapted. Generic storage is untouched.
 * The endpoint verifies ownership BEFORE we inspect/migrate browser-local data.
 * Edits are diffs against this device's loaded baseline, with server versions.
 */
export function createOncinCloudGallery(sessionId: string, shareId?: string, onMigrationFailure?: () => void, dependencies?: {
    list: typeof defaultList;
    upload: typeof defaultUpload;
    request: typeof defaultRequest;
}) {
    const listSessionImages = dependencies?.list ?? defaultList, uploadSessionImage = dependencies?.upload ?? defaultUpload, mediaRequest = dependencies?.request ?? defaultRequest;
    let baseline = new Map<string, SessionImage>();
    let loaded: Payload = { items: [] };
    let document = { value: {} as Record<string, unknown>, version: 0 };
    let enabled = false;
    let initialized = false;
    let hasLoaded = false;
    let tail: Promise<unknown> = Promise.resolve();
    async function readCloud(updateState = true, receiveDocument?: (value: typeof document) => void) {
        const all: SessionImage[] = [];
        let page: SessionImagePage;
        do {
            page = await listSessionImages(sessionId, all.length, shareId);
            all.push(...page.items);
            if (all.length > 500)
                throw new Error('Gallery exceeds the legacy adapter limit');
            if (all.length === page.items.length) {
                receiveDocument?.(page.document ?? { value: {}, version: 0 });
                if (updateState) {
                    document = page.document ?? { value: {}, version: 0 };
                    enabled = !!page.uploadsEnabled;
                    initialized = !!page.initialized;
                }
            }
        } while (page.hasMore);
        return all;
    }
    async function upload(item: Item) {
        return uploadSessionImage(sessionId, inlineImage(item.url), { entryId: item.id, uploadId: await stableUploadId(sessionId, item), filename: String(item.originalFileName || item.title || 'image').slice(0, 200), metadata: metadataOf(item) });
    }
    function compose(rows: SessionImage[], local: Item[] = []): Payload {
        const cloud = rows.filter(x => !x.deleted && x.metadata.legacy === 'oncin-v2').map(x => ({ ...x.metadata.item as Record<string, unknown>, id: x.entryId, url: x.url! } as Item));
        return { version: 2, ...document.value, items: [...cloud, ...local.filter(x => !rows.some(r => r.entryId === x.id))] };
    }
    async function load(rawLocal: () => string | null) {
        let rows = await readCloud();
        if (shareId) {
            baseline = new Map(rows.filter(x => x.metadata.legacy === 'oncin-v2').map(x => [x.entryId, x]));
            loaded = compose(rows);
            hasLoaded = true;
            return JSON.stringify(loaded);
        }
        // This callback is not invoked until the authenticated session read succeeds.
        const local = parse(rawLocal());
        if (!enabled && !initialized) {
            loaded = local;
            hasLoaded = true;
            return JSON.stringify(local);
        }
        const known = new Set<string>();
        for (let offset = 0; offset < local.items.length; offset += 100) {
            const result = await mediaRequest<{
                known: string[];
            }>(`session-media/session/${encodeURIComponent(sessionId)}/entry-status`, { method: 'POST', body: JSON.stringify({ ids: local.items.slice(offset, offset + 100).map(x => x.id) }) });
            result.known.forEach(id => known.add(id));
        }
        const pending = local.items.filter(x => !known.has(x.id));
        if (enabled) {
            for (const item of pending) {
                // Do not fetch arbitrary remote URLs. Keep unsupported originals local.
                if (!item.url.startsWith('data:'))
                    continue;
                try {
                    await upload(item);
                }
                catch {
                    onMigrationFailure?.();
                    break;
                }
            }
            const merged = mergeMigratingDocument(document.value, local, pending);
            if (local.items.length && !same(merged, document.value)) {
                try {
                    await mediaRequest(`session-media/session/${encodeURIComponent(sessionId)}/gallery`, { method: 'PATCH', body: JSON.stringify({ changes: [], document: { version: document.version, value: merged } }) });
                }
                catch {
                    onMigrationFailure?.();
                }
            }
            rows = await readCloud();
        }
        baseline = new Map(rows.filter(x => x.metadata.legacy === 'oncin-v2').map(x => [x.entryId, x]));
        loaded = { ...compose(rows, pending), ...mergeMigratingDocument(document.value, local, pending) };
        hasLoaded = true;
        return JSON.stringify(loaded);
    }
    async function save(raw: string) {
        if (!hasLoaded)
            throw new Error('Load the gallery before saving');
        if (shareId)
            throw new Error('This gallery is read-only');
        if (!enabled)
            throw new Error('Cloud image uploads are paused');
        const next = parse(raw), before = new Map(loaded.items.map(x => [x.id, x]));
        const changes: {
            entryId: string;
            version: number;
            metadata?: unknown;
            remove?: boolean;
        }[] = [];
        for (const [entryId, prior] of baseline) {
            const item = next.items.find(x => x.id === entryId);
            if (!item) {
                if (!prior.deleted)
                    changes.push({ entryId, version: prior.version, remove: true });
                continue;
            }
            if (prior.deleted)
                throw new Error('This image was permanently deleted');
            if (item.url !== before.get(entryId)?.url)
                throw new Error('Replacing an image requires a new gallery item');
            if (!same(metadataOf(item), prior.metadata))
                changes.push({ entryId, version: prior.version, metadata: metadataOf(item) });
        }
        const added: Item[] = [];
        for (const item of next.items) {
            if (!baseline.has(item.id)) {
                await upload(item);
                added.push(item);
            }
        }
        const value = documentOf(next);
        const documentChanged = !same(value, document.value);
        await mediaRequest(`session-media/session/${encodeURIComponent(sessionId)}/gallery`, { method: 'PATCH', body: JSON.stringify({ changes, ...(documentChanged ? { document: { version: document.version, value } } : {}) }) });
        // Only advance versions for changes this device confirmed. A subsequent
        // read may contain another device's edits; adopting those unseen versions
        // while retaining this device's old payload would bypass conflict checks.
        const confirmed = new Map(baseline);
        for (const change of changes) {
            if (change.remove) confirmed.delete(change.entryId);
            else confirmed.set(change.entryId, { ...baseline.get(change.entryId)!, version: change.version + 1, metadata: change.metadata as Record<string, unknown> });
        }
        let confirmedDocument = document;
        if (added.length || documentChanged) {
            const rows = await readCloud(false, current => { confirmedDocument = current; });
            if (documentChanged && !same(confirmedDocument.value, value)) {
                hasLoaded = false;
                throw new Error('Gallery changed on another device. Reload before editing.');
            }
            for (const item of added) {
                const row = rows.find(x => x.entryId === item.id);
                if (!row || row.deleted || !same(row.metadata, metadataOf(item))) {
                    hasLoaded = false;
                    throw new Error('Gallery changed on another device. Reload before editing.');
                }
                confirmed.set(item.id, row);
            }
        }
        baseline = confirmed;
        if (documentChanged) document = confirmedDocument;
        // Keep the same URLs the card was handed in the diff baseline. A refreshed
        // signed URL is transport detail, not a replacement-image operation.
        loaded = next;
    }
    return {
        get: (rawLocal: () => string | null) => { const result = tail.catch(() => { }).then(() => load(rawLocal)); tail = result; return result; },
        set: (raw: string) => { const result = tail.catch(() => { }).then(() => save(raw)); tail = result; return result; },
        get uploadsEnabled() { return enabled; },
        get usesCloud() { return enabled || initialized || !!shareId; },
    };
}
