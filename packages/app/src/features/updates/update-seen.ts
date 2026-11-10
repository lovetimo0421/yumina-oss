/**
 * "Is there something new?" for the update log, per browser.
 *
 * The viewer's last visit is a marker in localStorage: the newest entry date
 * they have seen plus the ids seen on that date (several entries can share a
 * day). The updates page writes it after it has been on screen and marks
 * newer entries 新. Storage can be missing or throw (private mode, blocked site
 * data): everything still works, it just forgets.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

const SEEN_KEY = "yumina-updates-seen";
/** With no marker yet (first visit), entries this recent count as new. */
const FIRST_VISIT_DAYS = 3;

export type SeenMarker = { date: string; ids: string[] } | null;

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: the marker just isn't remembered
  }
}

const listeners = new Set<() => void>();
let seen: SeenMarker | undefined;

function notify() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function seenSnapshot(): SeenMarker {
  if (seen === undefined) {
    const value = typeof window === "undefined" ? null : readJson<SeenMarker>(SEEN_KEY);
    seen = value && typeof value.date === "string" && Array.isArray(value.ids) ? value : null;
  }
  return seen;
}
function daysSince(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return Infinity;
  return (Date.now() - Date.UTC(y, m - 1, d)) / 86_400_000;
}

export function isUnseen(entry: { id: string; date: string }, marker: SeenMarker): boolean {
  if (!marker) return daysSince(entry.date) <= FIRST_VISIT_DAYS;
  return entry.date > marker.date || (entry.date === marker.date && !marker.ids.includes(entry.id));
}

/** Remember these entries as seen (call with what the page showed the reader). */
export function markSeen(entries: Array<{ id: string; date: string }>) {
  if (!entries.length) return;
  const newest = entries.reduce((max, e) => (e.date > max ? e.date : max), entries[0]!.date);
  const prev = seenSnapshot();
  if (prev && prev.date > newest) return;
  const ids = new Set(prev?.date === newest ? prev.ids : []);
  for (const e of entries) if (e.date === newest) ids.add(e.id);
  seen = { date: newest, ids: [...ids] };
  writeJson(SEEN_KEY, seen);
  notify();
}

export function useSeenMarker(): SeenMarker {
  return useSyncExternalStore(subscribe, seenSnapshot, () => null);
}

// ── "Is there an entry this browser hasn't seen?" for the Notifications panel ──
// Read lazily (only once something asks) and cached for ten minutes per language.
const LATEST_REFRESH_MS = 10 * 60 * 1000;
const latestCache = new Map<string, { at: number; promise: Promise<{ id: string; date: string } | null> }>();

function fetchLatest(lang: string): Promise<{ id: string; date: string } | null> {
  const hit = latestCache.get(lang);
  if (hit && Date.now() - hit.at < LATEST_REFRESH_MS) return hit.promise;
  // Vite's env is read here, not at module load: this module is also imported in tests without it.
  const apiBase = import.meta.env?.VITE_API_URL || "";
  const promise = fetch(`${apiBase}/api/changelog/latest?lang=${encodeURIComponent(lang)}`)
    .then((res) => (res.ok ? (res.json() as Promise<{ latest: { id: string; date: string } | null }>) : null))
    .then((body) => body?.latest ?? null)
    .catch(() => null);
  latestCache.set(lang, { at: Date.now(), promise });
  return promise;
}

/**
 * True when the newest public entry is newer than this browser's last visit.
 * `enabled` keeps it from fetching until it matters (the panel is open).
 */
export function useHasUnseenUpdate(lang: string, enabled = true): boolean {
  const marker = useSeenMarker();
  const [latest, setLatest] = useState<{ id: string; date: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetchLatest(lang).then((value) => {
      if (live) setLatest(value);
    });
    return () => {
      live = false;
    };
  }, [lang, enabled]);
  return latest ? isUnseen(latest, marker) : false;
}

// ── Opening the page from the bell ──
// The click marks the newest entry seen right away, so the gold dot goes out on the
// click instead of after the page loads. The marker from before the click is handed
// to the page so it can still badge what was new on this visit.
const HANDOFF_MS = 30_000;
let handoff: { marker: SeenMarker; at: number } | null = null;

export function markLatestSeen(lang: string) {
  void fetchLatest(lang).then((latest) => {
    if (!latest) return;
    const before = seenSnapshot();
    if (!isUnseen(latest, before)) return;
    handoff = { marker: before, at: Date.now() };
    markSeen([latest]);
  });
}

/** The marker the page should judge "new" against: the one from before the bell's click, if recent. */
export function markerBeforeOpen(current: SeenMarker): SeenMarker {
  return handoff && Date.now() - handoff.at < HANDOFF_MS ? handoff.marker : current;
}
