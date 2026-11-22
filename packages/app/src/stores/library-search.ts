import { create } from "zustand";

export type LibraryTab = "games" | "projects" | "assets" | "bundle" | "prompts";
export type LibraryGameSort = "title" | "recent" | "added";
export type LibraryGameFilter = "all" | "favorites" | "updates" | "unplayed" | "hidden" | `collection:${string}`;
export type LibraryProjectSort = "title" | "recent" | "releaseDate";

interface LibrarySearchStore {
  query: string;
  activeTab: LibraryTab;
  gameSort: LibraryGameSort;
  gameFilter: LibraryGameFilter;
  projectSort: LibraryProjectSort;
  defaultViewRequestId: number;
  setQuery: (query: string) => void;
  setActiveTab: (activeTab: LibraryTab) => void;
  setGameSort: (gameSort: LibraryGameSort) => void;
  setGameFilter: (gameFilter: LibraryGameFilter) => void;
  setProjectSort: (projectSort: LibraryProjectSort) => void;
  reset: () => void;
  requestDefaultView: () => void;
}

export const useLibrarySearchStore = create<LibrarySearchStore>((set) => ({
  query: "",
  activeTab: "games",
  gameSort: "recent",
  gameFilter: "all",
  projectSort: "title",
  defaultViewRequestId: 0,
  setQuery: (query) => set({ query }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setGameSort: (gameSort) => set({ gameSort }),
  setGameFilter: (gameFilter) => set({ gameFilter }),
  setProjectSort: (projectSort) => set({ projectSort }),
  reset: () => set({ query: "" }),
  requestDefaultView: () =>
    set((state) => ({
      query: "",
      activeTab: "games",
      gameFilter: "all",
      defaultViewRequestId: state.defaultViewRequestId + 1,
    })),
}));
