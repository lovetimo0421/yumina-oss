export interface CommunityThreadHandoff {
  title: string;
  content: string;
  forumSlug: string;
  assetId?: string;
  sessionId?: string;
  worldId?: string;
}

interface StoredHandoff extends CommunityThreadHandoff {
  storedAt: number;
}

const HANDOFF_KEY = "yumina-community-thread-handoff";

// Handoffs live briefly — long enough for a user to navigate from "Download
// complete" into the new-thread page (normally <1s), but not so long that a
// stale handoff gets silently applied on some unrelated future visit. 30s is
// comfortably more than any realistic navigation, and also outlives React 18
// StrictMode's synthetic mount → unmount → remount cycle in dev, so the form
// can safely read the handoff on every mount without clearing on read.
const HANDOFF_TTL_MS = 30_000;

let memoryHandoff: StoredHandoff | null = null;

export function storeCommunityThreadHandoff(handoff: CommunityThreadHandoff) {
  const stored: StoredHandoff = { ...handoff, storedAt: Date.now() };
  memoryHandoff = stored;

  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(stored));
  } catch {
    // Keep the in-memory copy so same-tab navigation still works for long text
    // even when sessionStorage throws (quota exceeded, storage disabled, etc).
  }
}

function readStoredHandoff(): StoredHandoff | null {
  if (typeof window !== "undefined") {
    try {
      const raw = window.sessionStorage.getItem(HANDOFF_KEY);
      if (raw) {
        return JSON.parse(raw) as StoredHandoff;
      }
    } catch {
      // Fall through to memoryHandoff.
    }
  }
  return memoryHandoff;
}

/**
 * Reads the pending handoff without consuming it. Callers should call
 * clearCommunityThreadHandoff() once they have committed the handoff to
 * their own state (e.g. after a successful submit or when the user cancels).
 *
 * Returns null if no handoff is pending or if the stored handoff has expired.
 * Expired handoffs are cleared as a side effect so a stale write cannot leak
 * into a later session.
 */
export function consumeCommunityThreadHandoff(): CommunityThreadHandoff | null {
  const stored = readStoredHandoff();
  if (!stored) return null;

  if (Date.now() - stored.storedAt > HANDOFF_TTL_MS) {
    clearCommunityThreadHandoff();
    return null;
  }

  // Return a fresh object without the internal `storedAt` bookkeeping.
  const { storedAt: _storedAt, ...handoff } = stored;
  void _storedAt;
  return handoff;
}

export function clearCommunityThreadHandoff() {
  memoryHandoff = null;

  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    // Nothing else to do — the in-memory copy is already cleared.
  }
}
