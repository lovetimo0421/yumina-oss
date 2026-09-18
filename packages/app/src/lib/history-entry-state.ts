const STORAGE_PREFIX = "yumina:history-entry-state:v1:";
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 100;

export interface HistoryEntryStateStorage {
  readonly length: number;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

interface StoredHistoryEntryState {
  version: typeof SNAPSHOT_VERSION;
  updatedAt: number;
  values: Record<string, unknown>;
}

export interface HistoryEntryStateRead<T> {
  found: boolean;
  value: T;
}

interface HistoryEntryPosition {
  key: string | undefined;
  index: number | undefined;
}

function storageKey(entryKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(entryKey)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(raw: string | null, now = Date.now()): StoredHistoryEntryState | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value)
      || value.version !== SNAPSHOT_VERSION
      || typeof value.updatedAt !== "number"
      || !Number.isFinite(value.updatedAt)
      || now - value.updatedAt > SNAPSHOT_TTL_MS
      || !isRecord(value.values)
    ) {
      return null;
    }
    return value as unknown as StoredHistoryEntryState;
  } catch {
    return null;
  }
}

export function getHistoryEntrySessionStorage(): HistoryEntryStateStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readHistoryEntryState<T>(
  storage: HistoryEntryStateStorage | null,
  entryKey: string | undefined,
  scope: string,
  fallback: T,
  validate: (value: unknown) => value is T,
): HistoryEntryStateRead<T> {
  if (!storage || !entryKey) return { found: false, value: fallback };

  try {
    const key = storageKey(entryKey);
    const snapshot = parseSnapshot(storage.getItem(key));
    if (!snapshot) {
      storage.removeItem(key);
      return { found: false, value: fallback };
    }
    const stored = snapshot.values[scope];
    return validate(stored)
      ? { found: true, value: stored }
      : { found: false, value: fallback };
  } catch {
    return { found: false, value: fallback };
  }
}

/**
 * TanStack assigns a new key even when it replaces the current browser entry.
 * A replacement is still the same logical Back/Forward entry, so carry its
 * local view state forward when no snapshot exists for the new key. Pushes and
 * history traversal change the index and continue to restore independently.
 */
export function resolveHistoryEntryStateTransition<T>(
  storage: HistoryEntryStateStorage | null,
  next: HistoryEntryPosition,
  previous: { index: number | undefined; value: T },
  scope: string,
  fallback: T,
  validate: (value: unknown) => value is T,
): T {
  const restored = readHistoryEntryState(storage, next.key, scope, fallback, validate);
  if (restored.found) return restored.value;

  const isReplacement = typeof next.index === "number" && next.index === previous.index;
  return isReplacement ? previous.value : fallback;
}

function cleanupSnapshots(storage: HistoryEntryStateStorage, now: number): void {
  const snapshots: Array<{ key: string; updatedAt: number }> = [];

  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    const snapshot = parseSnapshot(storage.getItem(key), now);
    if (!snapshot) {
      storage.removeItem(key);
      continue;
    }
    snapshots.push({ key, updatedAt: snapshot.updatedAt });
  }

  snapshots
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(MAX_SNAPSHOTS)
    .forEach(({ key }) => storage.removeItem(key));
}

export function writeHistoryEntryState(
  storage: HistoryEntryStateStorage | null,
  entryKey: string | undefined,
  scope: string,
  value: unknown,
): void {
  if (!storage || !entryKey) return;

  try {
    const key = storageKey(entryKey);
    const now = Date.now();
    const existing = parseSnapshot(storage.getItem(key), now);
    const snapshot: StoredHistoryEntryState = {
      version: SNAPSHOT_VERSION,
      updatedAt: now,
      values: { ...(existing?.values ?? {}), [scope]: value },
    };
    storage.setItem(key, JSON.stringify(snapshot));
    cleanupSnapshots(storage, now);
  } catch {
    // History state is an enhancement; navigation must work when storage fails.
  }
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
