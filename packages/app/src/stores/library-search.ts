import { create } from "zustand";

export type LibraryTab = "games" | "projects" | "assets" | "bundle";
export type LibraryGameSort = "title" | "recent" | "added";
export type LibraryProjectSort = "title" | "recent" | "releaseDate";

interface LibrarySearchStore {
  query: string;
  activeTab: LibraryTab;
  gameSort: LibraryGameSort;
  projectSort: LibraryProjectSort;
  defaultViewRequestId: number;
  setQuery: (query: string) => void;
  setActiveTab: (activeTab: LibraryTab) => void;
  setGameSort: (gameSort: LibraryGameSort) => void;
  setProjectSort: (projectSort: LibraryProjectSort) => void;
  reset: () => void;
  requestDefaultView: () => void;
}

export const useLibrarySearchStore = create<LibrarySearchStore>((set) => ({
  query: "",
  activeTab: "games",
  gameSort: "recent",
  projectSort: "title",
  defaultViewRequestId: 0,
  setQuery: (query) => set({ query }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setGameSort: (gameSort) => set({ gameSort }),
  setProjectSort: (projectSort) => set({ projectSort }),
  reset: () => set({ query: "" }),
  requestDefaultView: () =>
    set((state) => ({
      query: "",
      activeTab: "games",
      defaultViewRequestId: state.defaultViewRequestId + 1,
    })),
}));
