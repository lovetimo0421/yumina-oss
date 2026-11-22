import { create } from "zustand";
import type { Room } from "./api";

/** What the one invite sheet is open for: a story room, or a rules table a card's own UI hosts. */
export type InviteTarget =
  | { kind: "story"; room: Room }
  | { kind: "table"; worldId: string; code: string };

interface InviteSheetState {
  target: InviteTarget | null;
  /** Invited friend ids per link, so reopening the sheet keeps them. */
  invited: Record<string, string[]>;
  open: (target: InviteTarget) => void;
  close: () => void;
  markInvited: (link: string, friendId: string) => void;
}

export const useInviteSheet = create<InviteSheetState>()((set) => ({
  target: null,
  invited: {},
  open: (target) => set({ target }),
  close: () => set({ target: null }),
  markInvited: (link, friendId) =>
    set((s) => ({ invited: { ...s.invited, [link]: [...(s.invited[link] ?? []), friendId] } })),
}));

export function openStoryRoomInvite(room: Room) {
  useInviteSheet.getState().open({ kind: "story", room });
}
