type Gallery = Record<string, unknown> & { items: Record<string, unknown>[] };
function decode(value: unknown): Gallery {
  const root = typeof value === 'string' ? JSON.parse(value) : value;
  if (!root || typeof root !== 'object' || !Array.isArray(root.items) || root.items.length > 500)
    throw new Error('Invalid legacy gallery; the original has been preserved');
  const ids = new Set<string>();
  for (const item of root.items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('Invalid gallery image identity');
    ids.add(item.id);
  }
  return root;
}
function hash(text: string) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619) >>> 0;
  return value.toString(16).padStart(8, '0');
}
/** Read only exact, session-scoped keys after ownership has been checked.
 * Never union rollback/journal generations: doing so resurrects deleted items.
 * Variable and newer manifests are authoritative, including an empty gallery.
 */
export function readLegacyGallery(get: (key: string) => string | null, sid: string, variable?: unknown): string | null {
  const pending = get(`oncin:gallery:v2:${sid}:pending-cloud`);
  if (pending) return JSON.stringify(decode(pending));
  const v2 = () => get(`oncin:gallery:v2:${sid}`);
  const obj = variable && typeof variable === 'object' && !Array.isArray(variable) ? variable as Record<string, unknown> : undefined;
  const seed = obj?.data && typeof obj.data === 'object' ? obj.data : obj;
  if (seed && Object.keys(seed).length) return JSON.stringify(decode(seed));
  const v4 = get(`oncin:gallery:v4:${sid}`);
  const v3 = get(`oncin:gallery:v3:${sid}`);
  if (!v4 && !v3) {
    // Incomplete writes need their original recovery logic, not a guessed import.
    if (get(`oncin:gallery:v3:journal:${sid}`) || get(`oncin:gallery:v3:backup:${sid}`) || get(`oncin:gallery:v2:recovery:${sid}`))
      throw new Error('Gallery recovery is required; all original records have been preserved');
    const raw = v2();
    return raw ? JSON.stringify(decode(raw)) : null;
  }
  const data = decode(v4 || v3);
  if (Number(data.version) !== (v4 ? 4 : 3)) throw new Error('Unknown gallery manifest version');
  const items = data.items.map(item => {
    const source = v4 ? item.assetSource ?? 'v4' : 'v3';
    let url: unknown;
    if (source === 'v2') url = decode(v2()).items.find(row => row.id === item.id)?.url;
    else {
      if ((source !== 'v3' && source !== 'v4') || typeof item.assetId !== 'string' || !item.assetId) throw new Error('Invalid gallery asset reference');
      const raw = get(`oncin:gallery:${source}:asset:${sid}:${encodeURIComponent(item.assetId)}`);
      url = source === 'v3' ? raw : decode(raw).items.find(row => row.id === item.id)?.url;
    }
    if (typeof url !== 'string' || !url.startsWith('data:image/')) throw new Error('A gallery image is missing; original records have been preserved');
    if ((item.assetChars && item.assetChars !== url.length) || (item.assetHash && item.assetHash !== hash(url))) throw new Error('Gallery image integrity check failed');
    return { ...item, url };
  });
  return JSON.stringify({ ...data, version: 2, items });
}
