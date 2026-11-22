import { create } from "zustand";
import { collabApi, type SharedWorld } from "./collab-api";

const apiBase = import.meta.env?.VITE_API_URL || "";

export interface PendingInvite {
  worldId: string;
  role: "editor" | "viewer";
  worldName: string;
  thumbnailUrl: string | null;
  fromName: string;
}

/**
 * What became of the invitations to work on a card, wherever they were
 * answered: the bell, the live toast, My projects, another tab or another
 * device. The bell asks when it opens and My projects on focus; an answer
 * given here is known at once.
 */
interface CollabInvitesState {
  /** Answers given in this tab, ahead of the server round trip. */
  answered: Record<string, "accepted" | "declined">;
  /** Invitations still waiting for an answer, and cards already shared with me; null until first asked. */
  invites: PendingInvite[] | null;
  shared: SharedWorld[] | null;
  mark: (worldId: string, answer: "accepted" | "declined") => void;
  refresh: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

export const useCollabInvites = create<CollabInvitesState>((set) => ({
  answered: {},
  invites: null,
  shared: null,
  mark: (worldId, answer) => set((s) => ({
    answered: { ...s.answered, [worldId]: answer },
    invites: s.invites?.filter((i) => i.worldId !== worldId) ?? null,
  })),
  refresh: () => {
    // The bell, My projects and a toast can all ask at once.
    inFlight ??= Promise.all([fetchPendingInvites(), collabApi.shared()])
      .then(([invites, shared]) => set({ invites, shared }))
      .catch(() => { /* keep what we knew */ })
      .finally(() => { inFlight = null; });
    return inFlight;
  },
}));

export async function fetchPendingInvites(): Promise<PendingInvite[]> {
  const res = await fetch(`${apiBase}/api/world-collab/invites`, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json().catch(() => ({})) as { data?: PendingInvite[] };
  return body.data ?? [];
}

/** Accept or decline, and tell every list showing this invite. */
export async function answerCollabInvite(worldId: string, accept: boolean): Promise<void> {
  if (accept) await collabApi.accept(worldId);
  else await collabApi.decline(worldId);
  useCollabInvites.getState().mark(worldId, accept ? "accepted" : "declined");
  void useCollabInvites.getState().refresh();
}

/** Where an invitation row stands now. */
export function inviteState(
  state: Pick<CollabInvitesState, "answered" | "invites" | "shared">,
  worldId: string,
): "open" | "accepted" | "declined" | "gone" {
  const answer = state.answered[worldId];
  if (answer) return answer;
  if (state.shared?.some((w) => w.id === worldId)) return "accepted";
  if (state.invites && !state.invites.some((i) => i.worldId === worldId)) return "gone";
  return "open";
}
