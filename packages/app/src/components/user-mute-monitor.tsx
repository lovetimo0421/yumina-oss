import { useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import { useUserMuteStore } from "@/stores/user-mute";
import { UserMuteNotice } from "./user-mute-notice";

/** One live subscription for the shell and all social composers; never persisted. */
export function UserMuteMonitor() {
  const { data: session } = useSession();
  const userId = session?.user.id;
  useEffect(() => {
    const store = useUserMuteStore.getState();
    if (!userId) { store.clear(); return; }
    const refresh = () => { if (document.visibilityState !== "hidden") void store.refresh(userId); };
    refresh();
    const poll = window.setInterval(refresh, 30_000);
    const expiry = window.setInterval(store.expire, 1_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(expiry);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      store.clear();
    };
  }, [userId]);
  return <UserMuteNotice />;
}
