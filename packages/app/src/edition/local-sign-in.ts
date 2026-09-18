import { clearSessionCache, getSessionSafe } from "@/lib/auth-client";
import { IS_LOCAL_BUILD, ensureEditionLoaded } from "./edition";

let attempted: Promise<boolean> | null = null;

/**
 * Single-user mode: make sure the browser holds a session for the one local
 * account before any authenticated route renders. Resolves true when a
 * session exists (already or freshly minted). No-op in multi-user mode.
 *
 * The call is deduplicated for the page's lifetime so parallel route loaders
 * cannot race two sign-ins.
 *
 * Hosted builds never block on this: single-user mode only exists in the
 * local build, so the hosted shell must not pay a round trip to /api/edition
 * before its first route resolves. The descriptor still loads in the
 * background for feature gates.
 */
export function ensureLocalSession(): Promise<boolean> {
  if (attempted) return attempted;
  if (!IS_LOCAL_BUILD) {
    void ensureEditionLoaded();
    attempted = Promise.resolve(false);
    return attempted;
  }
  attempted = (async () => {
    const info = await ensureEditionLoaded();
    if (info.auth.mode !== "single-user") return false;
    const existing = await getSessionSafe();
    if (existing?.data?.user) return true;
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || ""}/api/local-auth/sign-in`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return false;
      clearSessionCache();
      const fresh = await getSessionSafe();
      return !!fresh?.data?.user;
    } catch {
      return false;
    }
  })();
  return attempted;
}
