import { create } from "zustand";
import { isUserMuted } from "@yumina/shared";

interface MuteState {
  userId: string | null;
  isMuted: boolean;
  mutedUntil: string | null;
  refresh: (userId: string) => Promise<void>;
  clear: () => void;
  expire: () => void;
}

export const useUserMuteStore = create<MuteState>((set, get) => ({
  userId: null, isMuted: false, mutedUntil: null,
  clear: () => set({ userId: null, isMuted: false, mutedUntil: null }),
  expire: () => {
    if (get().isMuted && !isUserMuted(get())) set({ isMuted: false });
  },
  refresh: async (userId) => {
    if (get().userId !== userId) set({ userId, isMuted: false, mutedUntil: null });
    try {
      const response = await fetch(`${import.meta.env?.VITE_API_URL || ""}/api/users/me/mute`, { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      const { data } = await response.json();
      if (get().userId === userId && data) {
        set({ isMuted: isUserMuted(data), mutedUntil: data.mutedUntil ?? null });
      }
    } catch { /* Preserve the last known state while offline. Server enforces every write. */ }
  },
}));
