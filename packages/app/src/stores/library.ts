import { create } from "zustand";
import { persist } from "zustand/middleware";
import { cachedFetch } from "@/lib/cached-fetch";
import type { CoverCropSettings } from "@/lib/cover-crop";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import { useFavoritesStore } from "@/edition/slots.state";
import { useUiStore } from "@/stores/ui";

export interface LibraryItem {
  libraryId: string;
  worldId: string;
  worldName: string;
  worldDescription: string;
  worldThumbnailUrl: string | null;
  worldCoverCrop?: CoverCropSettings | null;
  worldGalleryCoverCrop?: CoverCropSettings | null;
  worldStatus: string;
  worldTags: string[];
  worldIsNsfw: boolean;
  worldDownloadCount: number;
  worldMessageCount: number;
  creatorId: string;
  creatorName: string;
  creatorUsername: string | null;
  creatorImage: string | null;
  worldAllowEdit?: boolean | null;
  worldAllowReviews?: boolean | null;
  worldLanguage?: string | null;
  worldLanguageGroupId?: string | null;
  /** All variant worldIds the user has in their library that share this row's
   *  `worldLanguageGroupId`. Provided by the dedup'd `/api/library`. The
   *  representative variant's id is included. For ungrouped rows this is just
   *  `[worldId]`. Used by `markPlayed` / `isInLibrary` to find the right row
   *  when the caller knows about a sibling that isn't the current rep. */
  siblingWorldIds?: string[];
  addedAt: string;
  lastPlayedAt: string | null;
  lastSeenUpdateAt: string | null;
  hasUpdate: boolean;
}

interface LibraryStore {
  items: LibraryItem[];
  loading: boolean;
  lastFetchedAt: number | null;
  total: number;
  hasMore: boolean;

  fetchLibrary: () => Promise<void>;
  refreshLibrary: () => Promise<void>;
  fetchMore: () => Promise<void>;
  addToLibrary: (worldId: string) => Promise<void>;
  removeFromLibrary: (worldId: string) => Promise<void>;
  isInLibrary: (worldId: string) => boolean;
  markUpdateSeen: (worldId: string) => Promise<void>;
  markPlayed: (worldId: string, playedAt?: string) => void;
  invalidate: () => void;
  _cachedLang: string;
}

const apiBase = import.meta.env?.VITE_API_URL || "";

const tr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

const LIBRARY_PAGE_SIZE = 50;

export const useLibraryStore = create<LibraryStore>()(
  persist(
    (set, get) => ({
  items: [],
  loading: false,
  lastFetchedAt: null,
  total: 0,
  hasMore: false,
  _cachedLang: "" as string,

  fetchLibrary: () => {
    // Invalidate cache if language changed
    const currentLang = i18n.language;
    if (get()._cachedLang && get()._cachedLang !== currentLang) {
      set({ lastFetchedAt: null, _cachedLang: currentLang });
    }
    if (!get()._cachedLang) set({ _cachedLang: currentLang });

    return cachedFetch(
      () => get().items.length > 0,
      () => ({ lastFetchedAt: get().lastFetchedAt, loading: get().loading }),
      async () => {
        try {
          const res = await fetch(`${apiBase}/api/library?limit=${LIBRARY_PAGE_SIZE}&offset=0&lang=${encodeURIComponent(i18n.language)}`, {
            credentials: "include",
          });
          if (res.ok) {
            const { data, total } = await res.json();
            set({
              items: data as LibraryItem[],
              total: total ?? data.length,
              hasMore: data.length >= LIBRARY_PAGE_SIZE,
              loading: false,
              lastFetchedAt: Date.now(),
            });
          } else {
            set({ loading: false });
          }
        } catch {
          set({ loading: false });
        }
      },
      (v) => set({ loading: v }),
    );
  },

  // Reconcile server-side mutations without replacing an already-rendered
  // library with a loading state. This matters for inline actions such as
  // favorite toggles: collapsing the grid while the request is in flight
  // clamps the mobile scroll container back to the top.
  refreshLibrary: async () => {
    if (get().loading) return;
    // Re-fetch as many rows as are currently rendered (the server caps at 200),
    // so a user who pressed "Load more" keeps every page instead of snapping
    // back to the first 50 — which shrank the grid and jumped the scroll.
    const limit = Math.min(200, Math.max(LIBRARY_PAGE_SIZE, get().items.length));
    try {
      const res = await fetch(`${apiBase}/api/library?limit=${limit}&offset=0&lang=${encodeURIComponent(i18n.language)}`, {
        credentials: "include",
      });
      if (!res.ok) return;

      const { data, total } = await res.json();
      set({
        items: data as LibraryItem[],
        total: total ?? data.length,
        hasMore: data.length >= limit,
        lastFetchedAt: Date.now(),
        _cachedLang: i18n.language,
      });
    } catch {
      // Background reconciliation is best-effort. The optimistic favorite
      // state remains usable and the regular cache refresh will retry later.
    }
  },

  fetchMore: async () => {
    const { items, hasMore, loading } = get();
    if (!hasMore || loading) return;
    set({ loading: true });
    try {
      const res = await fetch(
        `${apiBase}/api/library?limit=${LIBRARY_PAGE_SIZE}&offset=${items.length}&lang=${encodeURIComponent(i18n.language)}`,
        { credentials: "include" },
      );
      if (res.ok) {
        const { data, total } = await res.json();
        const newItems = data as LibraryItem[];
        set({
          items: [...items, ...newItems],
          total: total ?? items.length + newItems.length,
          hasMore: newItems.length >= LIBRARY_PAGE_SIZE,
          loading: false,
        });
      } else {
        set({ loading: false });
      }
    } catch {
      set({ loading: false });
    }
  },

  addToLibrary: async (worldId) => {
    await fetch(`${apiBase}/api/library/${worldId}`, {
      method: "POST",
      credentials: "include",
    });
    set({ lastFetchedAt: null });
    await get().fetchLibrary();
  },

  removeFromLibrary: async (worldId) => {
    const removedIndex = get().items.findIndex((i) => i.worldId === worldId);
    const removed = removedIndex >= 0 ? get().items[removedIndex] : undefined;
    // The server cascades library-remove → favorite-remove; mirror that so the
    // heart goes dark without a refetch round-trip. Keep the row for rollback.
    const favoriteRow = useFavoritesStore.getState().favorites.find((f) => f.worldId === worldId);
    // Optimistic update
    set((s) => ({
      items: s.items.filter((i) => i.worldId !== worldId),
    }));
    useFavoritesStore.getState().removeLocal([worldId]);
    // R1: the row is already gone from the grid, so a failure has to put it
    // back — in its old slot, so the grid doesn't reshuffle on top of the
    // error — otherwise the user believes a removal that never happened.
    const rollback = () => {
      if (!removed) return;
      set((s) => {
        const items = s.items.filter((i) => i.worldId !== worldId);
        items.splice(Math.min(removedIndex, items.length), 0, removed);
        return { items };
      });
      if (favoriteRow) {
        useFavoritesStore.setState((s) => ({
          favorites: s.favorites.some((f) => f.worldId === worldId) ? s.favorites : [...s.favorites, favoriteRow],
        }));
      }
      feedback.error(tr("library:toast.removeFailed", "Couldn't remove from library"), {
        label: tr("common:action.retry", "Retry"),
        onClick: () => void get().removeFromLibrary(worldId),
      });
    };
    try {
      const res = await fetch(`${apiBase}/api/library/${worldId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) rollback();
      if (res.ok) {
        // Also drop the world from the mobile drawer's "recent worlds" list so
        // removing it from the library doesn't leave a ghost entry behind.
        useUiStore.getState().removeRecentPlayedWorld(worldId);
      }
    } catch {
      rollback();
    }
  },

  isInLibrary: (worldId) =>
    get().items.some(
      (i) => i.worldId === worldId || (i.siblingWorldIds?.includes(worldId) ?? false),
    ),

  markUpdateSeen: async (worldId) => {
    // Optimistic update
    set((s) => ({
      items: s.items.map((i) =>
        i.worldId === worldId ? { ...i, hasUpdate: false } : i,
      ),
    }));
    await fetch(`${apiBase}/api/library/${worldId}/seen`, {
      method: "PATCH",
      credentials: "include",
    });
  },

  markPlayed: (worldId, playedAt = new Date().toISOString()) => {
    set((s) => ({
      items: s.items.map((i) => {
        // The dedup'd library returns one row per language group with the
        // sibling worldIds attached. When a user plays a non-rep variant
        // (e.g. continues a 深度版 session of 轮回), we still want the
        // collapsed card's lastPlayedAt to bump.
        const matches =
          i.worldId === worldId || (i.siblingWorldIds?.includes(worldId) ?? false);
        return matches ? { ...i, lastPlayedAt: playedAt } : i;
      }),
    }));
  },

  // Something changed server-side (add/remove/session created): reconcile in
  // the background. Never wipe `items` first — an open library grid behind the
  // preview modal collapsed to a spinner and lost its scroll position every
  // time a card was added or removed. A never-loaded store still does a
  // normal first fetch.
  invalidate: () => {
    set({ lastFetchedAt: null });
    if (get().items.length === 0) {
      void get().fetchLibrary();
      return;
    }
    void get().refreshLibrary();
  },
    }),
    {
      name: "yumina-library",
      // v2: server now returns dedup'd library rows with `siblingWorldIds`.
      // Old persisted caches (v1) lack this field; bumping version forces
      // a clean fetch on first load instead of a stale-shape mismatch.
      version: 2,
      partialize: (state) => ({
        items: state.items,
        total: state.total,
        hasMore: state.hasMore,
      }),
    },
  ),
);
