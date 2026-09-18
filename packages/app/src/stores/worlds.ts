import { create } from "zustand";
import { cachedFetch } from "@/lib/cached-fetch";
import type { CoverCropSettings } from "@/lib/cover-crop";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import { useLibraryStore } from "./library";

export interface WorldItem {
  id: string;
  creatorId: string;
  name: string;
  description: string | null;
  schema: Record<string, unknown>;
  thumbnailUrl: string | null;
  coverCrop?: CoverCropSettings | null;
  galleryCoverCrop?: CoverCropSettings | null;
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
  fetchWorlds: () => Promise<void>;
  deleteWorld: (id: string) => Promise<boolean>;
  invalidate: () => void;
}

const apiBase = import.meta.env.VITE_API_URL || "";

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

export const useWorldsStore = create<WorldsState>((set, get) => ({
  worlds: [],
  loading: false,
  error: null,
  lastFetchedAt: null,
  _cachedLang: "" as string,

  fetchWorlds: () => {
    // Invalidate cache if language changed
    const currentLang = i18n.language;
    if (get()._cachedLang && get()._cachedLang !== currentLang) {
      set({ lastFetchedAt: null, _cachedLang: currentLang });
    }
    if (!get()._cachedLang) set({ _cachedLang: currentLang });

    return cachedFetch(
      () => get().worlds.length > 0,
      () => ({ lastFetchedAt: get().lastFetchedAt, loading: get().loading }),
      async () => {
        set({ error: null });
        try {
          const res = await fetch(`${apiBase}/api/worlds?lang=${encodeURIComponent(i18n.language)}`, {
            credentials: "include",
          });
          if (!res.ok) {
            // Stay silent on 401 (guest user) — just set empty
            if (res.status !== 401) loadWorldsFailed();
            set({ error: res.status === 401 ? null : "Failed to fetch worlds", worlds: [], loading: false });
            return;
          }
          const { data } = await res.json();
          set({ worlds: data, loading: false, lastFetchedAt: Date.now() });
        } catch {
          loadWorldsFailed();
          set({ error: "Network error", loading: false });
        }
      },
      (v) => set({ loading: v }),
    );
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
    set({ lastFetchedAt: null, worlds: [] });
    get().fetchWorlds();
  },
}));
