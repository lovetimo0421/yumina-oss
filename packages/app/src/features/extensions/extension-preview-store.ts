import { create } from "zustand";
import type { ExtensionSummary } from "@yumina/shared";

export type ExtensionPreviewTab = "overview" | "reviews";

interface ExtensionPreviewState {
  extension: ExtensionSummary | null;
  initialTab: ExtensionPreviewTab | null;
  open: (extension: ExtensionSummary, initialTab?: ExtensionPreviewTab) => void;
  close: () => void;
}

// Mounted globally (app-shell), so the profile section, Manage tiles, and
// Discover cards all open the same modal instance.
export const useExtensionPreview = create<ExtensionPreviewState>((set) => ({
  extension: null,
  initialTab: null,
  open: (extension, initialTab) => set({ extension, initialTab: initialTab ?? null }),
  close: () => set({ extension: null, initialTab: null }),
}));
