import { captureHubReturnState, isValidHubReturnState, restoreHubReturnState } from "@/edition/slots.state";
import type { HubReturnState } from "@/edition/slots.types";
import { useLibrarySearchStore } from "../stores/library-search";
import {
  parseSafeInternalReturnUrl,
  parseStoryReturnKey,
} from "./story-return-url";
import {
  captureRegisteredScrollPositions,
  queueExplicitScrollRestore,
  type RouteScrollPosition,
} from "./route-scroll-restoration";

export interface StoryReturnContext {
  returnTo?: string;
  returnKey?: string;
}

interface StoryReturnHistory {
  location: { state: { __TSR_index?: number } };
  back: () => void;
  replace: (path: string) => void;
  canGoBack: () => boolean;
}

interface StoryReturnSnapshot {
  version: 1;
  createdAt: number;
  returnTo: string;
  historyIndex?: number;
  /** Discover search state; the edition seam owns and validates its shape. */
  hub: HubReturnState;
  library: {
    query: string;
    activeTab: ReturnType<typeof useLibrarySearchStore.getState>["activeTab"];
    gameSort: ReturnType<typeof useLibrarySearchStore.getState>["gameSort"];
    projectSort: ReturnType<typeof useLibrarySearchStore.getState>["projectSort"];
  };
  communityFilters: string | null;
  scroll: RouteScrollPosition[];
}

const STORAGE_PREFIX = "yumina:story-return:";
const COMMUNITY_FILTERS_KEY = "community-home-filters";
const SNAPSHOT_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_RETURN_URL = "/app/library";

function createReturnKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function currentInternalUrl(): string {
  if (typeof window === "undefined") return DEFAULT_RETURN_URL;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function cleanupExpiredSnapshots(storage: Storage): void {
  const now = Date.now();
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      try {
        const value = JSON.parse(storage.getItem(key) ?? "null") as { createdAt?: unknown } | null;
        if (!value || typeof value.createdAt !== "number" || now - value.createdAt > SNAPSHOT_TTL_MS) {
          storage.removeItem(key);
        }
      } catch {
        storage.removeItem(key);
      }
    }
  } catch {
    // Storage cleanup is best-effort; navigation must keep working without it.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSnapshot(value: unknown, returnTo: string): value is StoryReturnSnapshot {
  if (!isRecord(value) || value.version !== 1 || value.returnTo !== returnTo) return false;
  if (typeof value.createdAt !== "number" || Date.now() - value.createdAt > SNAPSHOT_TTL_MS) return false;
  if (
    !isRecord(value.hub)
    || !isRecord(value.library)
    || !Array.isArray(value.scroll)
  ) return false;

  if (!isValidHubReturnState(value.hub)) return false;

  if (
    typeof value.library.query !== "string"
    || !["games", "projects", "assets", "bundle"].includes(String(value.library.activeTab))
    || !["title", "recent", "added"].includes(String(value.library.gameSort))
    || !["title", "recent", "releaseDate"].includes(String(value.library.projectSort))
    || !(value.communityFilters === null || typeof value.communityFilters === "string")
  ) {
    return false;
  }

  return value.scroll.every((position) => (
    isRecord(position)
    && typeof position.selector === "string"
    && typeof position.top === "number"
    && typeof position.left === "number"
  ));
}

export function captureStoryReturnContext(): StoryReturnContext {
  const returnTo = parseSafeInternalReturnUrl(currentInternalUrl()) ?? DEFAULT_RETURN_URL;
  const storage = getSessionStorage();
  if (!storage) return { returnTo };

  cleanupExpiredSnapshots(storage);
  const returnKey = createReturnKey();
  const library = useLibrarySearchStore.getState();
  const historyIndex = typeof window !== "undefined" && typeof window.history.state?.__TSR_index === "number"
    ? window.history.state.__TSR_index
    : undefined;

  try {
    const snapshot: StoryReturnSnapshot = {
      version: 1,
      createdAt: Date.now(),
      returnTo,
      historyIndex,
      hub: captureHubReturnState(),
      library: {
        query: library.query,
        activeTab: library.activeTab,
        gameSort: library.gameSort,
        projectSort: library.projectSort,
      },
      communityFilters: storage.getItem(COMMUNITY_FILTERS_KEY),
      scroll: captureRegisteredScrollPositions(),
    };

    storage.setItem(storageKey(returnKey), JSON.stringify(snapshot));
    return { returnTo, returnKey };
  } catch {
    return { returnTo };
  }
}

function readSnapshot(context: StoryReturnContext): StoryReturnSnapshot | null {
  const returnKey = parseStoryReturnKey(context.returnKey);
  const returnTo = parseSafeInternalReturnUrl(context.returnTo);
  const storage = getSessionStorage();
  if (!returnKey || !returnTo || !storage) return null;

  try {
    const snapshot: unknown = JSON.parse(storage.getItem(storageKey(returnKey)) ?? "null");
    return isValidSnapshot(snapshot, returnTo) ? snapshot : null;
  } catch {
    return null;
  }
}

function restorePageState(snapshot: StoryReturnSnapshot): void {
  restoreHubReturnState(snapshot.hub);
  useLibrarySearchStore.setState({ ...snapshot.library });

  const storage = getSessionStorage();
  if (storage) {
    try {
      if (snapshot.communityFilters !== null) {
        storage.setItem(COMMUNITY_FILTERS_KEY, snapshot.communityFilters);
      }
    } catch {
      // Store-backed Hub/Library state and navigation can still be restored.
    }
  }
}

/** Restore the captured page state, then leave the play page without trusting external URLs. */
export function navigateToStoryReturn(
  history: StoryReturnHistory,
  context: StoryReturnContext,
): void {
  const returnTo = parseSafeInternalReturnUrl(context.returnTo) ?? DEFAULT_RETURN_URL;
  const snapshot = readSnapshot({ ...context, returnTo });

  if (snapshot) {
    restorePageState(snapshot);
  } else if (returnTo === DEFAULT_RETURN_URL) {
    useLibrarySearchStore.getState().requestDefaultView();
  }

  const currentHistoryIndex = history.location.state.__TSR_index;
  const canUseCapturedBackEntry = Boolean(
    snapshot
    && typeof snapshot.historyIndex === "number"
    && currentHistoryIndex === snapshot.historyIndex + 1
    && history.canGoBack(),
  );

  queueExplicitScrollRestore(returnTo, snapshot?.scroll ?? []);
  if (canUseCapturedBackEntry) history.back();
  else history.replace(returnTo);
}
