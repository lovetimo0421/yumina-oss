/**
 * In-memory cache for the session picker's save list, so reopening the picker
 * paints instantly while a background refetch runs.
 *
 * Entries are scoped by the signed-in user. The cache used to be a module-level
 * Map keyed by world alone, which outlives sign-out → sign-in as a different
 * account in the same tab. The picker then painted the PREVIOUS account's
 * saves; tapping one navigated to a session the new account does not own, and
 * the chat surfaced the server's 404 ("Session not found") full-screen with
 * only a retry button — refresh and re-login both land on the same URL, so
 * from the user's side "the whole site is down" (2026-09-03 @kgwn report).
 *
 * With no known user there is nothing safe to key on, so reads miss and writes
 * are dropped: the picker shows its spinner and fetches fresh.
 */

const cache = new Map<string, unknown[]>();

export function sessionPickerCacheKey(
  userId: string | null | undefined,
  scopeKey: string,
): string | null {
  if (!userId) return null;
  return `${userId}|${scopeKey}`;
}

export function getCachedSessions<T>(
  userId: string | null | undefined,
  scopeKey: string,
): T[] | undefined {
  const key = sessionPickerCacheKey(userId, scopeKey);
  if (!key) return undefined;
  return cache.get(key) as T[] | undefined;
}

export function setCachedSessions<T>(
  userId: string | null | undefined,
  scopeKey: string,
  sessions: T[],
): void {
  const key = sessionPickerCacheKey(userId, scopeKey);
  if (!key) return;
  cache.set(key, sessions);
}

/** Drop every cached list. Called on sign-out alongside the zustand stores. */
export function clearSessionPickerCache(): void {
  cache.clear();
}
