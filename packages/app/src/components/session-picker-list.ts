// Pure helpers for the save picker (session-picker-modal.tsx): ordering,
// the instant (client-side) match, and the remembered sort.

export type SaveSort = "recent" | "oldest" | "messages" | "name";
export const SAVE_SORTS: readonly SaveSort[] = ["recent", "oldest", "messages", "name"];

/** Fewest saves on a card before the picker offers search + sort (the
 *  magnifier in its header, and Ctrl/Cmd+F). Below it the list is short
 *  enough to read, and the picker stays as plain as it always was. */
export const SAVE_SEARCH_MIN = 5;

/** Rows rendered at first and added per scroll step. */
export const SAVE_PAGE = 50;

export interface OrderableSave {
  id: string;
  pinnedAt?: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Same folding as the server (message-search.ts normalizeSearchQuery). */
export function normalizeSaveQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Case-insensitive substring match over the fields the row shows. */
export function matchesSaveLocally(fields: ReadonlyArray<string | null | undefined>, query: string): boolean {
  const q = query.toLowerCase();
  if (!q) return true;
  return fields.some((field) => !!field && field.replace(/\s+/g, " ").toLowerCase().includes(q));
}

function time(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Pinned saves first (newest pin on top), then the chosen sort. Ties fall
 *  back to most recently played, then id, so the order never flickers. */
export function orderSaves<T extends OrderableSave>(
  saves: readonly T[],
  sort: SaveSort,
  displayName: (save: T) => string,
  locale?: string,
): T[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const bySort = (a: T, b: T): number => {
    switch (sort) {
      case "oldest": return time(a.createdAt) - time(b.createdAt);
      case "messages": return b.messageCount - a.messageCount;
      case "name": return collator.compare(displayName(a), displayName(b));
      default: return time(b.updatedAt) - time(a.updatedAt);
    }
  };
  return saves.slice().sort((a, b) => {
    const pinA = a.pinnedAt ? time(a.pinnedAt) || 1 : 0;
    const pinB = b.pinnedAt ? time(b.pinnedAt) || 1 : 0;
    if ((pinA > 0) !== (pinB > 0)) return pinA > 0 ? -1 : 1;
    if (pinA > 0 && pinB > 0 && pinA !== pinB) return pinB - pinA;
    return bySort(a, b) || time(b.updatedAt) - time(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

const sortKey = (userId: string | null) => `yumina:save-picker-sort:${userId ?? "anon"}`;

export function readSaveSort(userId: string | null): SaveSort {
  try {
    const stored = window.localStorage.getItem(sortKey(userId));
    return SAVE_SORTS.includes(stored as SaveSort) ? (stored as SaveSort) : "recent";
  } catch {
    return "recent";
  }
}

export function writeSaveSort(userId: string | null, sort: SaveSort): void {
  try {
    window.localStorage.setItem(sortKey(userId), sort);
  } catch {
    // Private mode / blocked storage: the choice lasts this visit only.
  }
}
