import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";
import { useUserProfileStore } from "@/stores/user-profile";
import { resetHostedStoresOnSignOut } from "@/edition/slots.state";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";
import { useStudioSidebarStore } from "@/stores/studio-sidebar";
import { resetAnalyticsUser } from "@/lib/analytics";
import { clearSessionPickerCache } from "@/lib/session-picker-cache";
import { assetImportStore } from "@/stores/asset-import";
import { useUserAssetStore } from "@/stores/user-assets";

export const authClient = createAuthClient({
  baseURL: import.meta.env?.VITE_API_URL || "",
  plugins: [usernameClient()],
});

const {
  signIn,
  signUp,
  signOut: rawSignOut,
  useSession,
} = authClient;

export { signIn, signUp, useSession };

/**
 * Get session with retry for dev HMR resilience.
 * During Vite HMR, getSession() can transiently return null — retry once
 * after a short delay to avoid false redirects to /login.
 *
 * Results are cached for 30 seconds so that TanStack Router `beforeLoad`
 * checks don't block navigation with a network request on every route change.
 */
let sessionCache: { result: Awaited<ReturnType<typeof authClient.getSession>>; ts: number } | null = null;
const SESSION_CACHE_MS = 30_000;

export async function getSessionSafe() {
  // Return cached result if fresh — prevents route transitions from stalling
  // while the auth check round-trips to the server.
  if (sessionCache && Date.now() - sessionCache.ts < SESSION_CACHE_MS) {
    return sessionCache.result;
  }

  try {
    let session = await authClient.getSession();

    // Dev-only retry for HMR races on protected routes. Cache the outcome so
    // public auth navigations (e.g. /login) don't pay this delay on every visit.
    if (import.meta.env.DEV && !session.data) {
      await new Promise((r) => setTimeout(r, 500));
      session = await authClient.getSession();
    }

    sessionCache = { result: session, ts: Date.now() };
    return session;
  } catch {
    // Network error (e.g. server restarting during deploy) — fall back to
    // stale cache so we don't false-logout the user.
    if (sessionCache) {
      return sessionCache.result;
    }
    return { data: null } as Awaited<ReturnType<typeof authClient.getSession>>;
  }
}

/** Invalidate the session cache (call on sign-out). */
export function clearSessionCache() {
  sessionCache = null;
}

export function clearAllStores() {
  assetImportStore.getState().resetOwner(null);
  useUserAssetStore.getState().clear();
  useUserProfileStore.getState().clear();
  // Wallet, check-ins, follows, favorites: hosted-only stores reset behind the seam.
  resetHostedStoresOnSignOut();
  useLibraryStore.setState({ items: [], total: 0, hasMore: false, lastFetchedAt: null });
  // Module-level caches outlive the stores; a save list from the account
  // that just signed out must not paint for whoever signs in next.
  clearSessionPickerCache();
}

/**
 * Clear account-linked browser state after the server has irreversibly
 * deleted the account. Keep harmless display preferences, but remove profile,
 * billing/social caches, private editor recovery data, per-world sandbox
 * storage, recent world snapshots, and the analytics identity.
 */
export function clearLocalAuthStateAfterDeletion() {
  clearSessionCache();
  clearAllStores();
  useUiStore.setState({ recentPlayedWorlds: [] });
  useStudioSidebarStore.setState({ previewVariableOverridesByWorld: {} });
  resetAnalyticsUser();

  if (typeof window === "undefined") return;
  const exactLocalKeys = new Set([
    "yumina-editor-draft",
    "yumina-global-config",
  ]);
  const exactSessionKeys = new Set([
    "yumina-account-deletion-token",
    "yumina-community-thread-handoff",
  ]);
  const prefixes = [
    "yumina:local:",
    "yumina:session:",
    "yumina-studio-layout-",
    "yumina-studio-mobile-layout-",
  ];

  const clearStorage = (storage: Storage, exactKeys: Set<string>) => {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && (exactKeys.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))) {
        keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
  };

  try { clearStorage(window.localStorage, exactLocalKeys); } catch { /* storage unavailable */ }
  try { clearStorage(window.sessionStorage, exactSessionKeys); } catch { /* storage unavailable */ }
}

export async function signOut(...args: Parameters<typeof rawSignOut>) {
  clearSessionCache();
  clearAllStores();

  try {
    return await rawSignOut(...args);
  } finally {
    clearSessionCache();
    clearAllStores();
  }
}
