export interface ReadAfterWriteFlagStore {
  set(key: string, value: string, expiryMode: "EX", ttlSeconds: number): Promise<unknown>;
}

export async function setReadAfterWriteFlag(
  store: ReadAfterWriteFlagStore | null | undefined,
  userId: string,
): Promise<boolean> {
  if (!store) return false;
  try {
    await store.set(`rw:${userId}`, "1", "EX", 5);
    return true;
  } catch {
    return false;
  }
}
