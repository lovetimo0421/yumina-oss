import { create } from "zustand";

interface CreatePageState {
  isPickerActive: boolean;
  setPickerActive: (active: boolean) => void;
}

export const useCreatePageStore = create<CreatePageState>((set) => ({
  isPickerActive: true,
  setPickerActive: (active) => set({ isPickerActive: active }),
}));
