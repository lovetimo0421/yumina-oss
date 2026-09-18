import { create } from "zustand";
import {
  uploadAssetWithPresignedUrl,
  type UploadProgress,
} from "@/lib/asset-upload";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";

export interface Asset {
  id: string;
  worldId: string;
  type: "image" | "audio" | "font" | "txt" | "other";
  filename: string;
  url: string; // presigned GET URL
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

interface AssetState {
  assets: Asset[];
  loading: boolean;
  uploading: boolean;
  uploadingCount: number;
  uploadProgress: UploadProgress | null;
  storage: { used: number; limit: number };

  fetchAssets: (worldId: string) => Promise<void>;
  uploadAsset: (
    worldId: string,
    file: File,
    type: "image" | "audio" | "font" | "txt" | "other"
  ) => Promise<Asset | null>;
  deleteAsset: (worldId: string, assetId: string) => Promise<void>;
  clear: () => void;
}

const apiBase = import.meta.env.VITE_API_URL || "";

const tr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

export const useAssetStore = create<AssetState>((set) => ({
  assets: [],
  loading: false,
  uploading: false,
  uploadingCount: 0,
  uploadProgress: null,
  storage: { used: 0, limit: 0 },

  fetchAssets: async (worldId) => {
    set({ loading: true });
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/assets`, {
        credentials: "include",
      });
      if (!res.ok) {
        set({ loading: false });
        return;
      }
      const { data } = await res.json();
      set({ assets: data ?? [], loading: false });
    } catch {
      set({ loading: false });
    }
  },

  uploadAsset: async (worldId, file, type) => {
    set((s) => ({
      uploadingCount: s.uploadingCount + 1,
      uploading: true,
      uploadProgress: null,
    }));

    try {
      const asset = await uploadAssetWithPresignedUrl<Asset>({
        file,
        preferredType: type,
        prepareUrl: `${apiBase}/api/worlds/${worldId}/assets/upload-url`,
        registerUrl: `${apiBase}/api/worlds/${worldId}/assets`,
        registerBody: ({ key, resolvedType, contentType }) => ({
          key,
          filename: file.name,
          type: resolvedType,
          mimeType: contentType,
          sizeBytes: file.size,
        }),
        onProgress: (progress) => set({ uploadProgress: progress }),
      });

      set((s) => ({
        assets: [...s.assets, asset],
        storage: { ...s.storage, used: s.storage.used + (file.size ?? 0) },
      }));

      // R6/T0: the grid shows a progress bar while this runs and the new asset
      // lands in it — the upload announces itself.
      return asset;
    } catch {
      feedback.error(tr("library:assets.uploadFailed", "Couldn't upload the file"));
      return null;
    } finally {
      set((s) => {
        const uploadingCount = Math.max(0, s.uploadingCount - 1);

        return {
          uploadingCount,
          uploading: uploadingCount > 0,
        };
      });
    }
  },

  // R5/T4: the delete already runs behind a confirm dialog and the tile leaves
  // the grid, so only the failure — which leaves the tile there — speaks.
  deleteAsset: async (worldId, assetId) => {
    const failed = () =>
      feedback.error(tr("library:assets.deleteFailed", "Couldn't delete the asset"));
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/assets/${assetId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        failed();
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
      failed();
    }
  },

  clear: () =>
    set({
      assets: [],
      loading: false,
      uploading: false,
      uploadingCount: 0,
      uploadProgress: null,
      storage: { used: 0, limit: 0 },
    }),
}));
