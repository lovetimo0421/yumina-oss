import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { useUserProfileStore } from "@/stores/user-profile";
import { resetHostedStoresOnSignOut } from "@/edition/slots.state";
import { useLibraryStore } from "@/stores/library";
import { useWorldsStore } from "@/stores/worlds";
import { useUiStore } from "@/stores/ui";
import { useStudioSidebarStore } from "@/stores/studio-sidebar";
import { resetAnalyticsUser } from "@/lib/analytics";
import { clearSessionPickerCache } from "@/lib/session-picker-cache";
import { assetImportStore } from "@/stores/asset-import";
import { useUserAssetStore } from "@/stores/user-assets";
import { createSessionCheck } from "@/lib/session-check";

export const authClient = createAuthClient({
  baseURL: import.meta.env?.VITE_API_URL || "",
  // oauthProviderClient: on /login and /oauth/consent it sends the signed
  // authorization query along, so an outside AI's sign-in can continue.
  plugins: [usernameClient(), oauthProviderClient()],
});

const {
  signIn,
  signUp,
  signOut: rawSignOut,
  useSession,
} = authClient;

export { signIn, signUp, useSession };

/**
 * Session check for route guards (see session-check.ts): only the server's
 * "signed in / signed out" is cached, for 30s; a network or server hiccup
 * keeps the last known answer instead of reading as signed out.
 */
const sessionCheck = createSessionCheck(() => authClient.getSession(), {
  // Vite HMR can briefly answer "no session" in dev.
  retrySignedOut: () => Boolean(import.meta.env?.DEV),
});

export const getSessionSafe = sessionCheck.get;

/** True when getSessionSafe() could not reach a verdict (not the same as signed out). */
export const isSessionUnverified = sessionCheck.isUnverified;

/** Invalidate the session cache (call on sign-out). */
export const clearSessionCache = sessionCheck.clear;

export function clearAllStores() {
  assetImportStore.getState().resetOwner(null);
  useUserAssetStore.getState().clear();
  useUserProfileStore.getState().clear();
  // Wallet, check-ins, follows, favorites: hosted-only stores reset behind the seam.
  resetHostedStoresOnSignOut();
  useLibraryStore.setState({ items: [], total: 0, hasMore: false, lastFetchedAt: null });
  useWorldsStore.getState().clear();
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
