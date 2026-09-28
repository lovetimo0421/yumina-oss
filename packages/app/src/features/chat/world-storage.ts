/** Browser-local, world-scoped UI cache. This is not a cloud/session save. */
export function scopeStorageKey(worldId: string, rawKey: unknown): string {
  const key = String(rawKey);
  if (key.startsWith(`yumina:local:${worldId}:`) || key.startsWith(`yumina:session:${worldId}:`)) {
    return key;
  }
  return `yumina:local:${worldId}:${key}`;
}

export function writeWorldStorage(storage: Storage, key: string, value: string): void {
  // Never reclaim space by deleting creator-owned data. Even keys belonging
  // to this world may hold another session's only copy of a gallery or save.
  // Let the bridge reject storage.set on failure so callers do not mark an
  // unsaved payload as persisted. Browser setItem leaves the old value intact.
  storage.setItem(key, value);
}
