import { useStore } from "zustand";
import { createAssetImportStore, type AssetImportStore } from "@/lib/asset-import-task";
import { useUserAssetStore } from "./user-assets";

export const assetImportStore = createAssetImportStore({
  storage: () => useUserAssetStore.getState().storage,
  createFolder: (name, parentId, signal, requestId) => useUserAssetStore.getState().createFolder(name, parentId, { silent: true, signal, requestId }),
  upload: (file, type, folderId, signal, onProgress, onStage, requestId) => useUserAssetStore.getState().uploadAsset(file, type, folderId,
    { silent: true, addToList: false, signal, onProgress, onStage, requestId }),
});
export const useAssetImportStore = <T,>(selector: (state: AssetImportStore) => T) => useStore(assetImportStore, selector);
