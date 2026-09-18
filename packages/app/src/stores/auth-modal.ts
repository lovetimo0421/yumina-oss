import { create } from "zustand";

interface AuthModalState {
    isOpen: boolean;
    contextMessage: string;
    open: (contextMessage: string) => void;
    close: () => void;
}

export const useAuthModalStore = create<AuthModalState>((set) => ({
    isOpen: false,
    contextMessage: "",
    open: (contextMessage: string) =>
        set({ isOpen: true, contextMessage }),
    close: () => set({ isOpen: false, contextMessage: "" }),
}));
