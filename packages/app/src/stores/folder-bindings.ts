import { create } from "zustand";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import { useUserAssetStore } from "./user-assets";

export interface BoundFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  assetCount: number;
  previewAssetIds: string[];
}

interface FolderBindingState {
  worldId: string | null;
  bindings: BoundFolder[];
  loading: boolean;
  error: boolean;
  /** Load the folders bound to a world (replaces current state). */
  fetch: (worldId: string) => Promise<void>;
  /**
   * Bind a folder to a world. Works for any world the user owns.
   * Pass `worldName` to optimistically light up the folder's badge before the
   * server confirms (rolled back on failure).
   */
  bind: (worldId: string, folderId: string, worldName?: string) => Promise<boolean>;
  /** Unbind a folder from a world. */
  unbind: (worldId: string, folderId: string) => Promise<void>;
  clear: () => void;
}

const apiBase = import.meta.env.VITE_API_URL || "";
let bindingRequest = 0;
// Unlike request ordering, this changes only when the active world changes.
// Mutation responses may refresh the same world after a read, but must never
// revive a world that was left (even if it has since been reopened).
let bindingScope = 0;

// Copy lives in the `library` namespace: every surface that can bind a folder
// renders through bound-assets-view, which loads that namespace.
const tr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

// Keep the library's folder list badges in sync after a binding change.
function refreshFolderBadges() {
  void useUserAssetStore.getState().fetchFolders();
}

export const useFolderBindingStore = create<FolderBindingState>((set, get) => ({
  worldId: null,
  bindings: [],
  loading: false,
  error: false,

  fetch: async (worldId) => {
    if (get().worldId !== worldId) bindingScope++;
    const request = ++bindingRequest;
    set({ loading: true, error: false, worldId, ...(get().worldId !== worldId ? { bindings: [] } : {}) });
    try {
      const res = await fetch(
        `${apiBase}/api/worlds/${worldId}/folder-bindings`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Folder bindings could not load");
      const { data } = await res.json();
      // Ignore late responses for a world we've since navigated away from.
      if (get().worldId !== worldId || request !== bindingRequest) return;
      if (!Array.isArray(data)) throw new Error("Invalid folder bindings");
      set({ bindings: data, loading: false, error: false });
    } catch {
      if (get().worldId === worldId && request === bindingRequest) set({ loading: false, error: true });
    }
  },

  bind: async (worldId, folderId, worldName) => {
    const assets = useUserAssetStore.getState();

    // Optimistic: light up the folder's badge in the library grid…
    if (worldName !== undefined) {
      assets.optimisticBindFolder(folderId, { worldId, worldName });
    }
    // …and slot the folder into the active card's bound list immediately.
    const bindingActiveWorld = get().worldId === worldId;
    const scope = bindingScope;
    const stillActive = () => bindingActiveWorld && get().worldId === worldId && bindingScope === scope;
    if (bindingActiveWorld && !get().bindings.some((b) => b.id === folderId)) {
      const f = assets.folders.find((x) => x.id === folderId);
      if (f) {
        set((s) => ({
          bindings: [
            ...s.bindings,
            {
              id: f.id,
              name: f.name,
              parentFolderId: f.parentFolderId,
              createdAt: f.createdAt,
              assetCount: f.assetCount,
              previewAssetIds: [],
            },
          ].sort((a, b) => a.name.localeCompare(b.name)),
        }));
      }
    }

    try {
      const res = await fetch(
        `${apiBase}/api/worlds/${worldId}/folder-bindings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ folderId }),
        },
      );
      if (!res.ok) {
        // Roll back the optimistic updates.
        if (worldName !== undefined) assets.optimisticUnbindFolder(folderId, worldId);
        if (stillActive()) {
          set((s) => ({ bindings: s.bindings.filter((b) => b.id !== folderId) }));
        }
        const body = await res.json().catch(() => ({}));
        console.error("Folder bind failed:", (body as { error?: string }).error);
        bindFailed(worldId, folderId, worldName);
        return false;
      }
      // Reconcile counts/previews in the background (badge already correct).
      refreshFolderBadges();
      if (stillActive()) await get().fetch(worldId);
      return true;
    } catch {
      if (worldName !== undefined) assets.optimisticUnbindFolder(folderId, worldId);
      if (stillActive()) {
        set((s) => ({ bindings: s.bindings.filter((b) => b.id !== folderId) }));
      }
      bindFailed(worldId, folderId, worldName);
      return false;
    }
  },

  unbind: async (worldId, folderId) => {
    const scope = bindingScope;
    const stillActive = () => get().worldId === worldId && bindingScope === scope;
    // Optimistic removal from both the active card's list and the folder badge.
    if (get().worldId === worldId) {
      set((s) => ({ bindings: s.bindings.filter((b) => b.id !== folderId) }));
    }
    useUserAssetStore.getState().optimisticUnbindFolder(folderId, worldId);
    try {
      const res = await fetch(
        `${apiBase}/api/worlds/${worldId}/folder-bindings/${folderId}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        unbindFailed(worldId, folderId);
        // Re-sync from the server to undo the optimistic removal.
        refreshFolderBadges();
        if (stillActive()) await get().fetch(worldId);
        return;
      }
      refreshFolderBadges();
    } catch {
      unbindFailed(worldId, folderId);
      refreshFolderBadges();
      if (stillActive()) await get().fetch(worldId);
    }
  },

  clear: () => { bindingRequest++; bindingScope++; set({ worldId: null, bindings: [], loading: false, error: false }); },
}));

// R7: binding happens from a grid badge that has already rolled back, so the
// only thing left to say is "it didn't stick" — with the same call as a Retry.
function bindFailed(worldId: string, folderId: string, worldName?: string) {
  feedback.error(tr("library:bindings.bindFailed", "Couldn't bind the folder"), {
    label: tr("common:action.retry", "Retry"),
    onClick: () => void useFolderBindingStore.getState().bind(worldId, folderId, worldName),
  });
}

function unbindFailed(worldId: string, folderId: string) {
  feedback.error(tr("library:bindings.unbindFailed", "Couldn't unbind the folder"), {
    label: tr("common:action.retry", "Retry"),
    onClick: () => void useFolderBindingStore.getState().unbind(worldId, folderId),
  });
}
