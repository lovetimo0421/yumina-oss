import { create } from "zustand";
import type {
  ExtensionSummary,
  ExtensionDetail,
  ExtensionInstallStatus,
} from "@yumina/shared";

const apiBase = import.meta.env.VITE_API_URL || "";
const FRESH_MS = 30_000;

export type ExtensionSort = "recommended" | "popular" | "newest";

interface ExtensionsState {
  // Discover catalog
  catalog: ExtensionSummary[];
  catalogLoading: boolean;
  catalogFetchedAt: number | null;
  catalogCacheKey: string | null;

  // Manage lists
  installedList: ExtensionSummary[];
  uninstalledList: ExtensionSummary[];
  manageLoading: boolean;
  manageFetchedAt: number | null;

  // Per-user install status map — the single source of truth for gating + card state
  installState: Record<string, ExtensionInstallStatus>;
  detailCache: Record<string, ExtensionDetail>;
  detailLoading: Record<string, boolean>;
  pendingAction: Record<string, boolean>;

  fetchCatalog: (query: string, category: string, sort: ExtensionSort) => Promise<void>;
  fetchManage: (force?: boolean) => Promise<void>;
  fetchInstallState: () => Promise<void>;
  fetchDetail: (key: string) => Promise<ExtensionDetail | null>;
  install: (key: string) => Promise<boolean>;
  uninstall: (key: string) => Promise<boolean>;
  reinstall: (key: string) => Promise<boolean>;
  invalidate: () => void;
}

function foldInstallState(
  base: Record<string, ExtensionInstallStatus>,
  items: ExtensionSummary[],
): Record<string, ExtensionInstallStatus> {
  const next = { ...base };
  for (const it of items) {
    if (it.installState) next[it.key] = it.installState.status;
  }
  return next;
}

export const useExtensionsStore = create<ExtensionsState>((set, get) => ({
  catalog: [],
  catalogLoading: false,
  catalogFetchedAt: null,
  catalogCacheKey: null,

  installedList: [],
  uninstalledList: [],
  manageLoading: false,
  manageFetchedAt: null,

  installState: {},
  detailCache: {},
  detailLoading: {},
  pendingAction: {},

  fetchCatalog: async (query, category, sort) => {
    const cacheKey = `${query}|${category}|${sort}`;
    const s = get();
    if (
      s.catalogCacheKey === cacheKey &&
      s.catalogFetchedAt &&
      Date.now() - s.catalogFetchedAt < FRESH_MS
    ) {
      return;
    }
    set({ catalogLoading: true });
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (category) params.set("category", category);
      params.set("sort", sort);
      const res = await fetch(`${apiBase}/api/extensions/hub?${params.toString()}`, {
        credentials: "include",
      });
      if (res.ok) {
        const { data } = await res.json();
        const items: ExtensionSummary[] = data ?? [];
        set((st) => ({
          catalog: items,
          catalogFetchedAt: Date.now(),
          catalogCacheKey: cacheKey,
          installState: foldInstallState(st.installState, items),
        }));
      }
    } catch {
      // silent
    } finally {
      set({ catalogLoading: false });
    }
  },

  fetchManage: async (force = false) => {
    const s = get();
    if (
      !force &&
      s.manageFetchedAt &&
      Date.now() - s.manageFetchedAt < FRESH_MS
    ) {
      return;
    }
    set({ manageLoading: true });
    try {
      const res = await fetch(`${apiBase}/api/extensions/mine`, { credentials: "include" });
      if (res.ok) {
        const { data } = await res.json();
        const installed: ExtensionSummary[] = data?.installed ?? [];
        const uninstalled: ExtensionSummary[] = data?.uninstalled ?? [];
        set((st) => ({
          installedList: installed,
          uninstalledList: uninstalled,
          manageFetchedAt: Date.now(),
          installState: foldInstallState(st.installState, [...installed, ...uninstalled]),
        }));
      }
    } catch {
      // silent
    } finally {
      set({ manageLoading: false });
    }
  },

  // Cheap silent seed for gating (e.g. on login) — populates installState only.
  fetchInstallState: async () => {
    try {
      const res = await fetch(`${apiBase}/api/extensions/mine`, { credentials: "include" });
      if (res.ok) {
        const { data } = await res.json();
        const installed: ExtensionSummary[] = data?.installed ?? [];
        const uninstalled: ExtensionSummary[] = data?.uninstalled ?? [];
        set((st) => ({
          installState: foldInstallState(st.installState, [...installed, ...uninstalled]),
        }));
      }
    } catch {
      // silent
    }
  },

  fetchDetail: async (key) => {
    set((s) => ({ detailLoading: { ...s.detailLoading, [key]: true } }));
    try {
      const res = await fetch(`${apiBase}/api/extensions/${key}`, { credentials: "include" });
      if (res.ok) {
        const { data } = await res.json();
        const detail: ExtensionDetail = data;
        set((s) => ({
          detailCache: { ...s.detailCache, [key]: detail },
          installState: detail.installState
            ? { ...s.installState, [key]: detail.installState.status }
            : s.installState,
        }));
        return detail;
      }
      return null;
    } catch {
      return null;
    } finally {
      set((s) => ({ detailLoading: { ...s.detailLoading, [key]: false } }));
    }
  },

  install: (key) => mutate(set, get, key, "installed", "POST", `/api/extensions/${key}/install`),
  reinstall: (key) => mutate(set, get, key, "installed", "POST", `/api/extensions/${key}/reinstall`),
  uninstall: (key) => mutate(set, get, key, "uninstalled", "DELETE", `/api/extensions/${key}/install`),

  invalidate: () => set({ catalogFetchedAt: null, catalogCacheKey: null, manageFetchedAt: null }),
}));

// Shared optimistic install/uninstall/reinstall: flip installState + move the
// summary between Manage lists, POST/DELETE, reconcile on success or roll back.
async function mutate(
  set: (partial: Partial<ExtensionsState>) => void,
  get: () => ExtensionsState,
  key: string,
  status: ExtensionInstallStatus,
  method: "POST" | "DELETE",
  path: string,
): Promise<boolean> {
  const s = get();
  const rollback = {
    installState: s.installState,
    installedList: s.installedList,
    uninstalledList: s.uninstalledList,
  };
  const summary =
    s.catalog.find((e) => e.key === key) ??
    s.installedList.find((e) => e.key === key) ??
    s.uninstalledList.find((e) => e.key === key);

  const installedList = s.installedList.filter((e) => e.key !== key);
  const uninstalledList = s.uninstalledList.filter((e) => e.key !== key);
  if (summary) {
    const moved: ExtensionSummary = {
      ...summary,
      installState: {
        status,
        installedAt: summary.installState?.installedAt ?? new Date().toISOString(),
        uninstalledAt: status === "uninstalled" ? new Date().toISOString() : null,
      },
    };
    if (status === "installed") installedList.unshift(moved);
    else uninstalledList.unshift(moved);
  }

  set({
    installState: { ...s.installState, [key]: status },
    installedList,
    uninstalledList,
    pendingAction: { ...s.pendingAction, [key]: true },
  });

  try {
    const res = await fetch(`${apiBase}${path}`, { method, credentials: "include" });
    if (!res.ok) throw new Error("request failed");
    set({ pendingAction: { ...get().pendingAction, [key]: false } });
    get().invalidate();
    void get().fetchManage(true);
    return true;
  } catch {
    set({ ...rollback, pendingAction: { ...get().pendingAction, [key]: false } });
    return false;
  }
}
