import { useEffect, useSyncExternalStore } from "react";
import { useSession } from "@/lib/auth-client";
import { IS_LOCAL_BUILD } from "@/edition/edition";
import { CLOSED_DISCOVER_ACCESS, currentDiscoverAccess, parseDiscoverAccess, type DiscoverAccess } from "@/lib/discover-access-state";

type Snapshot = { owner: string | null; access: DiscoverAccess; loaded: boolean };
let snapshot: Snapshot = { owner: null, access: CLOSED_DISCOVER_ACCESS, loaded: false };
let pending: { owner: string; controller: AbortController } | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;
function update(next: Snapshot) { snapshot = next; listeners.forEach(listener => listener()); }
async function load(owner: string, refresh = false) {
  if (pending?.owner === owner || (!refresh && snapshot.owner === owner && snapshot.loaded)) return;
  pending?.controller.abort();
  const controller = new AbortController(); pending = { owner, controller };
  // Account switches close the preview synchronously through currentDiscoverAccess.
  if (snapshot.owner !== owner) update({ owner, access: CLOSED_DISCOVER_ACCESS, loaded: false });
  try {
    const response = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/discover/access`, { credentials: "include", cache: "no-store", signal: controller.signal });
    const access = response.ok ? parseDiscoverAccess(await response.json()) : CLOSED_DISCOVER_ACCESS;
    if (!controller.signal.aborted) update({ owner, access, loaded: true });
  } catch { if (!controller.signal.aborted) update({ owner, access: CLOSED_DISCOVER_ACCESS, loaded: true }); }
  finally { if (pending?.controller === controller) pending = null; }
}

export function useDiscoverAccess() {
  const { data: session, isPending } = useSession();
  const owner = session?.user?.id ?? "guest";
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (isPending || IS_LOCAL_BUILD) return;
    void load(owner);
    const refresh = () => { void load(owner, true); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [owner, isPending]);
  return IS_LOCAL_BUILD ? { ...CLOSED_DISCOVER_ACCESS, loading: false } : { ...(isPending ? CLOSED_DISCOVER_ACCESS : currentDiscoverAccess(owner, state.owner, state.access)), loading: isPending || state.owner !== owner || !state.loaded };
}
