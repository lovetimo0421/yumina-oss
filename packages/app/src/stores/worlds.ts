import { create } from "zustand";
import type { CoverCropSettings } from "@/lib/cover-crop";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import { useLibraryStore } from "./library";

export interface WorldItem {
  id: string;
  creatorId: string;
  name: string;
  description: string | null;
  // Lightweight world lists omit the full schema; only detail responses include it.
  schema?: Record<string, unknown> | null;
  thumbnailUrl: string | null;
  coverCrop?: CoverCropSettings | null;
  galleryCoverCrop?: CoverCropSettings | null;
  landscapeCoverUrl?: string | null;
  landscapeCoverCrop?: CoverCropSettings | null;
  isPublished: boolean | null;
  status?: string | null;
  isNsfw: boolean | null;
  blurCover?: boolean | null;
  allowEdit: boolean | null;
  allowReviews?: boolean | null;
  downloadCount: number;
  messageCount?: number | null;
  favoriteCount?: number | null;
  tags: string[] | null;
  announcement: string | null;
  totalTokens: number | null;
  approxTime: string | null;
  galleryImages: string[] | null;
  sourceWorldId: string | null;
  sourceWorldTakenDown: boolean | null;
  // Filled in by the server when sourceWorldId is set, so the "based on
  // X by Y" attribution can render without needing the source world to
  // sit in any local store.
  sourceWorldName?: string | null;
  sourceCreatorId?: string | null;
  sourceCreatorName?: string | null;
  moderationNote: string | null;
  moderationAction: string | null;
  creatorName: string | null;
  language?: string | null;
  languageGroupId?: string | null;
  createdAt: string;
  updatedAt: string;
  reviewStatus?: "pending_review" | "approved" | "rejected" | null;
  submittedForReviewAt?: string | null;
  rejectionReason?: string | null;
  rejectionDetail?: string | null;
  // Held-edit (re-review) state for a PUBLISHED card the caller owns. The live
  // card stays `status: "published"` while an edit is held/queued, so this is
  // the ONLY signal that a published card has an update 待提交/审核中/被拒.
  // Null for non-owned cards and for cards with no held edit.
  pendingEdit?: PendingEditSummary | null;
}

export interface PendingEditSummary {
  status: "draft" | "pending" | "rejected";
  submittedAt: string | null;
  reasons: string[];
  rejectionReason: string | null;
  rejectionDetail: string | null;
  updatedAt: string | null;
}

interface WorldsState {
  worlds: WorldItem[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  _cachedLang: string;
  fetchWorlds: (options?: WorldListOptions) => Promise<void>;
  deleteWorld: (id: string) => Promise<boolean>;
  invalidate: () => void;
  clear: () => void;
}

export interface WorldListOptions {
  scope?: "library";
  userId?: string;
  worldId?: string;
}

const apiBase = import.meta.env?.VITE_API_URL || "";

const tr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

// R7: the world list loads in the background (sidebar, pickers), so a failure
// has nowhere inline to live. Retry re-fetches past the cache.
function loadWorldsFailed() {
  feedback.error(tr("library:toast.loadWorldsFailed", "Couldn't load your worlds"), {
    label: tr("common:action.retry", "Retry"),
    onClick: () => useWorldsStore.getState().invalidate(),
  });
}

export const useWorldsStore = create<WorldsState>((set, get) => {
  let lastOptions: WorldListOptions = {};
  let cacheKey = "";
  let cachedRequestedId: string | undefined;
  let generation = 0;
  let inFlight: { key: string; promise: Promise<void> } | null = null;

  return {
    worlds: [],
    loading: false,
    error: null,
    lastFetchedAt: null,
    _cachedLang: "" as string,

    fetchWorlds: (options = {}) => {
      const lang = i18n.language;
      const scopeKey = JSON.stringify([options.scope ?? "all", options.userId ?? "", lang]);
      const key = JSON.stringify([scopeKey, options.worldId ?? ""]);
      lastOptions = { ...options };
      if (inFlight?.key === key) return inFlight.promise;
      const state = get();
      // Opening a card already present in the list, or returning from it, must
      // reuse that list. Otherwise every Back action would flash its spinner.
      const hasRequestedWorld = !options.worldId || cachedRequestedId === options.worldId
        || state.worlds.some((world) => world.id === options.worldId);
      const age = state.worlds.length > 0 && cacheKey === scopeKey && hasRequestedWorld && state.lastFetchedAt !== null
        ? Date.now() - state.lastFetchedAt : Infinity;
      if (age < 30_000) {
        // The requested cached view wins over an older, different pending view.
        if (inFlight) { ++generation; inFlight = null; set({ loading: false }); }
        return Promise.resolve();
      }

      const requestGeneration = ++generation;
      // Keep stale rows visible during background refresh, as before. A scope or
      // language switch must fetch even when the previous list is still fresh.
      set({ error: null, loading: age >= 300_000, _cachedLang: lang });
      const query = new URLSearchParams({ lang });
      if (options.scope) query.set("scope", options.scope);
      if (options.scope && options.worldId) query.set("worldId", options.worldId);
      const promise = (async () => {
        try {
          const res = await fetch(`${apiBase}/api/worlds?${query}`, {
            credentials: "include",
          });
          if (requestGeneration !== generation) return;
          if (!res.ok) {
            // Stay silent on 401 (guest user) — just set empty
            if (res.status !== 401) loadWorldsFailed();
            cacheKey = "";
            set({ error: res.status === 401 ? null : "Failed to fetch worlds", worlds: [], loading: false, lastFetchedAt: null });
            return;
          }
          const { data } = await res.json();
          if (requestGeneration !== generation) return;
          cacheKey = scopeKey;
          cachedRequestedId = options.worldId;
          set({ worlds: data, loading: false, lastFetchedAt: Date.now() });
        } catch {
          if (requestGeneration !== generation) return;
          loadWorldsFailed();
          set({ error: "Network error", loading: false });
        }
      })();
      inFlight = { key, promise };
      const settled = () => { if (requestGeneration === generation) inFlight = null; };
      void promise.then(settled, settled);
      return promise;
    },

    // R5/T4: deleting a world already goes through a type-to-confirm modal and the
    // card vanishes from the grid, so success says nothing. Only the failure —
    // which leaves the card in place — needs a pill.
    deleteWorld: async (id) => {
      const failed = () =>
        feedback.error(tr("library:toast.deleteWorldFailed", "Couldn't delete this world"));
      try {
        const res = await fetch(`${apiBase}/api/worlds/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) {
          failed();
          return false;
        }
        set((s) => ({ worlds: s.worlds.filter((w) => w.id !== id) }));
        useLibraryStore.getState().invalidate();
        return true;
      } catch {
        failed();
        return false;
      }
    },

    invalidate: () => {
      ++generation;
      inFlight = null;
      cacheKey = "";
      cachedRequestedId = undefined;
      set({ lastFetchedAt: null, worlds: [] });
      void get().fetchWorlds(lastOptions);
    },

    clear: () => {
      ++generation;
      inFlight = null;
      cacheKey = "";
      cachedRequestedId = undefined;
      lastOptions = {};
      set({ worlds: [], loading: false, error: null, lastFetchedAt: null, _cachedLang: "" });
    },
  };
});
