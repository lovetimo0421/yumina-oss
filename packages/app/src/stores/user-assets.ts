import { create } from "zustand";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import {
  getAssetUploadErrorMessage,
  uploadAssetWithPresignedUrl,
  type UploadProgress,
  type UploadAssetType,
  type AssetUploadStage,
  createUploadTimeout,
} from "@/lib/asset-upload";

const tr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

export interface UserAsset {
  id: string;
  userId: string;
  type: "image" | "video" | "audio" | "font" | "txt" | "other";
  filename: string;
  url: string;
  mimeType: string | null;
  sizeBytes: number | null;
  folderId: string | null;
  sourceAssetId: string | null;
  createdAt: string;
}

export interface BoundWorldRef {
  worldId: string;
  worldName: string;
}

export interface AssetFolder {
  id: string;
  userId: string;
  name: string;
  parentFolderId: string | null;
  assetCount: number;
  createdAt: string;
  // Worlds this folder is bound to (organizational only — see folder-bindings).
  boundWorlds?: BoundWorldRef[];
}

const PAGE_SIZE = 50;

interface UserAssetState {
  assets: UserAsset[];
  folders: AssetFolder[];
  loading: boolean;
  uploading: boolean;
  uploadingCount: number;
  uploadProgress: UploadProgress | null;
  storage: { used: number; limit: number };
  page: number;
  total: number;
  pageSize: number;

  fetchAssets: (opts?: { type?: string; folderId?: string; search?: string; page?: number }) => Promise<void>;
  fetchAssetById: (assetId: string) => Promise<UserAsset | null>;
  setPage: (page: number) => void;
  fetchFolders: () => Promise<void>;
  uploadAsset: (file: File, type: UploadAssetType, folderId?: string, options?: { requestId?: string; silent?: boolean; addToList?: boolean; signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void; onStage?: (stage: AssetUploadStage) => void }) => Promise<UserAsset | null>;
  deleteAsset: (assetId: string) => Promise<void>;
  renameAsset: (assetId: string, filename: string) => Promise<void>;
  moveAsset: (assetId: string, folderId: string | null) => Promise<void>;
  createFolder: (name: string, parentFolderId?: string, options?: { requestId?: string; silent?: boolean; signal?: AbortSignal }) => Promise<AssetFolder | null>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  /** Optimistically reflect a folder→world binding on the folder's badge. */
  optimisticBindFolder: (folderId: string, world: BoundWorldRef) => void;
  /** Optimistically remove a folder→world binding from the folder's badge. */
  optimisticUnbindFolder: (folderId: string, worldId: string) => void;
  clear: () => void;
}

const apiBase = import.meta.env.VITE_API_URL || "";
let accountEpoch = 0;

export const useUserAssetStore = create<UserAssetState>((set, get) => ({
  assets: [],
  folders: [],
  loading: false,
  uploading: false,
  uploadingCount: 0,
  uploadProgress: null,
  storage: { used: 0, limit: 100 * 1024 * 1024 },
  page: 1,
  total: 0,
  pageSize: PAGE_SIZE,

  fetchAssets: async (opts) => {
    set({ loading: true });
    try {
      const page = opts?.page ?? get().page;
      const params = new URLSearchParams();
      if (opts?.type) params.set("type", opts.type);
      if (opts?.folderId) params.set("folderId", opts.folderId);
      if (opts?.search) params.set("search", opts.search);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));

      const url = `${apiBase}/api/user-assets${params.toString() ? `?${params}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        set({ loading: false });
        return;
      }
      const { data, storage, total } = await res.json();
      set({
        assets: data ?? [],
        storage: storage ?? get().storage,
        total: total ?? 0,
        page,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  fetchAssetById: async (assetId) => {
    try {
      const res = await fetch(`${apiBase}/api/user-assets/${assetId}`, {
        credentials: "include",
      });
      if (!res.ok) return null;

      const { data } = await res.json();
      if (!data) return null;

      set((s) => ({
        assets: s.assets.some((asset) => asset.id === data.id)
          ? s.assets.map((asset) => (asset.id === data.id ? data : asset))
          : [data, ...s.assets],
      }));

      return data as UserAsset;
    } catch {
      return null;
    }
  },

  setPage: (page) => {
    set({ page });
  },

  fetchFolders: async () => {
    try {
      const res = await fetch(`${apiBase}/api/user-assets/folders`, { credentials: "include" });
      if (!res.ok) return;
      const { data } = await res.json();
      set({ folders: data ?? [] });
    } catch {
      // silent
    }
  },

  uploadAsset: async (file, type, folderId, options) => {
    const epoch = accountEpoch;
    let reconciled = false;
    if (options?.signal?.aborted) return null;
    set((s) => ({
      uploadingCount: s.uploadingCount + 1,
      uploading: true,
      uploadProgress: null,
    }));

    try {
      const asset = await uploadAssetWithPresignedUrl<UserAsset>({
        file,
        preferredType: type,
        prepareUrl: `${apiBase}/api/user-assets/upload-url`,
        registerUrl: `${apiBase}/api/user-assets`,
        prepareBody: { requestId: options?.requestId, sizeBytes: file.size },
        onReconciled: () => { reconciled = true; },
        signal: options?.signal,
        onStage: options?.onStage,
        registerBody: ({ key, resolvedType, contentType }) => ({
          requestId: options?.requestId,
          key,
          filename: file.name,
          type: resolvedType,
          mimeType: contentType,
          sizeBytes: file.size,
          folderId: folderId ?? undefined,
        }),
        onProgress: (progress) => {
          if (epoch !== accountEpoch || options?.signal?.aborted) return;
          set({ uploadProgress: progress });
          options?.onProgress?.(progress);
        },
      });

      if (epoch !== accountEpoch || options?.signal?.aborted) return null;
      set((s) => ({
        assets: options?.addToList === false ? s.assets : [...s.assets, asset],
        storage: { ...s.storage, used: s.storage.used + (reconciled ? 0 : file.size) },
      }));

      return asset;
    } catch (error) {
      if (!options?.silent) feedback.error(getAssetUploadErrorMessage(error), {
        label: tr("common:action.retry", "Retry"),
        onClick: () => void useUserAssetStore.getState().uploadAsset(file, type, folderId),
      });
      return null;
    } finally {
      if (epoch === accountEpoch) {
        set((s) => {
          const uploadingCount = Math.max(0, s.uploadingCount - 1);

          return {
            uploadingCount,
            uploading: uploadingCount > 0,
          };
        });
      }
    }
  },

  deleteAsset: async (assetId) => {
    // Callers gate this behind their own confirm step (two-tap or dialog), so
    // the item's disappearance from the grid is the only evidence needed.
    try {
      const res = await fetch(`${apiBase}/api/user-assets/${assetId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        feedback.error(tr("library:toast.deleteAssetFailed", "Couldn't delete asset"), {
          label: tr("common:action.retry", "Retry"),
          onClick: () => void useUserAssetStore.getState().deleteAsset(assetId),
        });
        return;
      }
      set((s) => {
        const deleted = s.assets.find((a) => a.id === assetId);
        return {
          assets: s.assets.filter((a) => a.id !== assetId),
          storage: {
            ...s.storage,
            used: Math.max(0, s.storage.used - (deleted?.sizeBytes ?? 0)),
          },
        };
      });
    } catch {
      feedback.error(tr("library:toast.deleteAssetFailed", "Couldn't delete asset"), {
        label: tr("common:action.retry", "Retry"),
        onClick: () => void useUserAssetStore.getState().deleteAsset(assetId),
      });
    }
  },

  renameAsset: async (assetId, filename) => {
    try {
      const res = await fetch(`${apiBase}/api/user-assets/${assetId}/rename`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ filename }),
      });
      if (!res.ok) {
        feedback.error(tr("library:toast.renameAssetFailed", "Couldn't rename asset"), {
          label: tr("common:action.retry", "Retry"),
          onClick: () => void useUserAssetStore.getState().renameAsset(assetId, filename),
        });
        return;
      }
      set((s) => ({
        assets: s.assets.map((a) => (a.id === assetId ? { ...a, filename } : a)),
      }));
    } catch {
      feedback.error(tr("library:toast.renameAssetFailed", "Couldn't rename asset"), {
        label: tr("common:action.retry", "Retry"),
        onClick: () => void useUserAssetStore.getState().renameAsset(assetId, filename),
      });
    }
  },

  moveAsset: async (assetId, folderId) => {
    try {
      const res = await fetch(`${apiBase}/api/user-assets/${assetId}/move`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) {
        feedback.error(tr("library:toast.moveAssetFailed", "Couldn't move asset"), {
          label: tr("common:action.retry", "Retry"),
          onClick: () => void useUserAssetStore.getState().moveAsset(assetId, folderId),
        });
        return;
      }
      set((s) => ({
        assets: s.assets.map((a) => (a.id === assetId ? { ...a, folderId } : a)),
      }));
    } catch {
      feedback.error(tr("library:toast.moveAssetFailed", "Couldn't move asset"), {
        label: tr("common:action.retry", "Retry"),
        onClick: () => void useUserAssetStore.getState().moveAsset(assetId, folderId),
      });
    }
  },

  createFolder: async (name, parentFolderId, options) => {
    const epoch = accountEpoch;
    const timeout = createUploadTimeout(20_000, options?.signal);
    try {
      timeout.signal.throwIfAborted();
      const res = await fetch(`${apiBase}/api/user-assets/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, parentFolderId, requestId: options?.requestId }),
        signal: timeout.signal,
      });
      if (!res.ok) {
        if (!options?.silent) feedback.error(tr("library:toast.createFolderFailed", "Couldn't create folder"), {
          label: tr("common:action.retry", "Retry"),
          onClick: () => void useUserAssetStore.getState().createFolder(name, parentFolderId),
        });
        return null;
      }
      const { data } = await res.json();
      if (epoch !== accountEpoch || options?.signal?.aborted) return null;
      set((s) => ({ folders: s.folders.some(folder => folder.id === data.id)
        ? s.folders.map(folder => folder.id === data.id ? { ...folder, ...data } : folder)
        : [...s.folders, data] }));
      return data;
    } catch {
      if (!options?.silent) feedback.error(tr("library:toast.createFolderFailed", "Couldn't create folder"), {
        label: tr("common:action.retry", "Retry"),
        onClick: () => void useUserAssetStore.getState().createFolder(name, parentFolderId),
      });
      return null;
    } finally {
      timeout.cleanup();
    }
  },

  renameFolder: async (folderId, name) => {
    try {
      const res = await fetch(`${apiBase}/api/user-assets/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        feedback.error(tr("library:toast.renameFolderFailed", "Couldn't rename folder"), {
          label: tr("common:action.retry", "Retry"),
          onClick: () => void useUserAssetStore.getState().renameFolder(folderId, name),
        });
        return;
      }
      set((s) => ({
        folders: s.folders.map((f) => (f.id === folderId ? { ...f, name } : f)),
      }));
    } catch {
      feedback.error(tr("library:toast.renameFolderFailed", "Couldn't rename folder"), {
        label: tr("common:action.retry", "Retry"),
        onClick: () => void useUserAssetStore.getState().renameFolder(folderId, name),
      });
    }
  },

  // No confirm step exists upstream (one click deletes), so this is the
  // undo-able variant: remove locally now, defer the server call until the
  // undo window closes (R5b).
  deleteFolder: async (folderId) => {
    const folder = get().folders.find((f) => f.id === folderId);
    if (!folder) return;
    const movedAssetIds = get().assets.filter((a) => a.folderId === folderId).map((a) => a.id);

    set((s) => ({
      folders: s.folders.filter((f) => f.id !== folderId),
      assets: s.assets.map((a) => (a.folderId === folderId ? { ...a, folderId: null } : a)),
    }));

    feedback.undo(
      tr("library:toast.folderDeleted", "Folder deleted"),
      () => {
        set((s) => ({
          folders: [...s.folders, folder],
          assets: s.assets.map((a) => (movedAssetIds.includes(a.id) ? { ...a, folderId } : a)),
        }));
      },
      {
        onCommit: () => {
          void fetch(`${apiBase}/api/user-assets/folders/${folderId}`, {
            method: "DELETE",
            credentials: "include",
          })
            .then((res) => {
              if (!res.ok) {
                feedback.error(tr("library:toast.deleteFolderFailed", "Couldn't delete folder"));
              }
            })
            .catch(() => {
              feedback.error(tr("library:toast.deleteFolderFailed", "Couldn't delete folder"));
            });
        },
      },
    );
  },

  optimisticBindFolder: (folderId, world) =>
    set((s) => ({
      folders: s.folders.map((f) =>
        f.id === folderId
          ? {
              ...f,
              boundWorlds: [
                ...(f.boundWorlds ?? []).filter((b) => b.worldId !== world.worldId),
                world,
              ],
            }
          : f,
      ),
    })),

  optimisticUnbindFolder: (folderId, worldId) =>
    set((s) => ({
      folders: s.folders.map((f) =>
        f.id === folderId
          ? { ...f, boundWorlds: (f.boundWorlds ?? []).filter((b) => b.worldId !== worldId) }
          : f,
      ),
    })),

  clear: () => {
    accountEpoch++;
    set({
      assets: [],
      folders: [],
      loading: false,
      uploading: false,
      uploadingCount: 0,
      uploadProgress: null,
      storage: { used: 0, limit: 100 * 1024 * 1024 },
      page: 1,
      total: 0,
    });
  },
}));
