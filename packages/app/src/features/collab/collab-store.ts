import { create } from "zustand";

/** Someone else with the open card in front of them, per editor tab. */
export interface Peer {
  userId: string;
  clientId: string;
  name: string;
  image: string | null;
  focus: Record<string, string> | null;
  /** When we last heard from them. */
  seenAt: number;
}

export interface PresenceEvent {
  userId: string;
  clientId: string;
  name: string;
  image: string | null;
  focus: Record<string, string> | null;
  gone: boolean;
  hello?: boolean;
}

/** Where someone's pointer is on the board, what they have selected, and their view. */
export interface PeerCursor {
  userId: string;
  clientId: string;
  name: string;
  x?: number;
  y?: number;
  /** The pointer left the board. */
  out?: boolean;
  /** Canvas id of what they last selected or typed in. */
  sel?: string | null;
  /** Centre of their view in board coordinates, and zoom (for following). */
  view?: { x: number; y: number; zoom: number };
  at: number;
}

export interface CursorEvent extends Omit<PeerCursor, "at"> { at?: string }

/** Each person keeps one colour wherever they appear (pointer, outline, face). */
const PEER_COLORS = ["#f24e1e", "#0d99ff", "#14ae5c", "#9747ff", "#e2468e", "#ff8a00", "#1abcfe", "#d6a400"];
export function peerColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length]!;
}

/** Fired with { section } when a click on someone's face should take this
 *  editor to the part of the card they are in (the phone Studio listens). */
export const COLLAB_GOTO_SECTION_EVENT = "yumina:collab-goto-section";

/** A tab that hasn't checked in for this long has closed or lost its connection. */
export const PEER_TIMEOUT_MS = 50_000;

interface CollabState {
  worldId: string | null;
  peers: Record<string, Peer>;
  /** Bumped when someone's access to the card changed; the share dialog reloads. */
  accessVersion: number;
  /** Bumped when someone just connected and wants to know who is here. */
  helloVersion: number;
  cursors: Record<string, PeerCursor>;
  /** The person whose view this board follows. */
  following: string | null;
  /** True while the board with everyone's pointers is on screen (LiveCursors
   *  is mounted): only there does a click on a face follow that person. */
  canFollow: boolean;
  setCanFollow: (on: boolean) => void;
  /** Text this person had typed and not saved when they were removed from
   *  the card, offered for copying on the "no longer shared" screen. Kept
   *  across reset(): the card has already closed by the time it's shown. */
  removedUnsaved: string | null;
  reset: (worldId: string | null) => void;
  applyPresence: (event: PresenceEvent, ownClientId: string) => void;
  applyCursor: (event: CursorEvent, ownClientId: string) => void;
  setFollowing: (userId: string | null) => void;
  prune: () => void;
  bumpAccess: () => void;
}

export const useCollabStore = create<CollabState>((set) => ({
  worldId: null,
  peers: {},
  accessVersion: 0,
  helloVersion: 0,
  cursors: {},
  following: null,
  canFollow: false,
  removedUnsaved: null,
  setCanFollow: (canFollow) => set(canFollow ? { canFollow } : { canFollow, following: null }),
  reset: (worldId) => set({ worldId, peers: {}, cursors: {}, following: null }),
  applyPresence: (event, ownClientId) => set((s) => {
    if (event.clientId === ownClientId) return {};
    const peers = { ...s.peers };
    if (event.gone) {
      delete peers[event.clientId];
      const { [event.clientId]: _gone, ...cursors } = s.cursors;
      return { peers, cursors };
    }
    const { hello, ...peer } = event;
    peers[event.clientId] = { ...peer, seenAt: Date.now() };
    return hello ? { peers, helloVersion: s.helloVersion + 1 } : { peers };
  }),
  applyCursor: (event, ownClientId) => set((s) => {
    if (event.clientId === ownClientId) return {};
    const prev = s.cursors[event.clientId];
    const next: PeerCursor = { ...prev, ...event, at: Date.now() };
    // A pointer update that leaves the board keeps the last spot hidden.
    if (event.x === undefined && prev) { next.x = prev.x; next.y = prev.y; }
    const peer = s.peers[event.clientId];
    return {
      cursors: { ...s.cursors, [event.clientId]: next },
      // A cursor is as good as a heartbeat.
      ...(peer ? { peers: { ...s.peers, [event.clientId]: { ...peer, seenAt: Date.now() } } } : {}),
    };
  }),
  setFollowing: (following) => set({ following }),
  prune: () => set((s) => {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    const live = Object.fromEntries(Object.entries(s.peers).filter(([, p]) => p.seenAt >= cutoff));
    if (Object.keys(live).length === Object.keys(s.peers).length) return {};
    const cursors = Object.fromEntries(Object.entries(s.cursors).filter(([id]) => live[id]));
    return { peers: live, cursors };
  }),
  bumpAccess: () => set((s) => ({ accessVersion: s.accessVersion + 1 })),
}));

/** One entry per person (several tabs collapse), most recently active first. */
export function peoplePresent(peers: Record<string, Peer>): Peer[] {
  const byUser = new Map<string, Peer>();
  for (const p of Object.values(peers)) {
    const prev = byUser.get(p.userId);
    if (!prev || p.seenAt > prev.seenAt) byUser.set(p.userId, p);
  }
  return [...byUser.values()].sort((a, b) => b.seenAt - a.seenAt);
}
