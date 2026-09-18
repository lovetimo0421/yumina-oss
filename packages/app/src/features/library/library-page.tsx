import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch, useNavigate, useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useWorldsStore, type WorldItem } from "@/stores/worlds";
import { useLibraryStore } from "@/stores/library";
import { useSession } from "@/lib/auth-client";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { useUserProfileStore } from "@/stores/user-profile";
import { LibraryGameGrid } from "./library-game-grid";
import { LibraryMyProjects } from "./library-my-projects";
import { LibraryAssetsTab } from "./library-assets-tab";
import { LibraryBundlesTab } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { LibraryDetailPanel } from "./library-detail-panel";
import { LibraryFavoritesView } from "./library-favorites-view";
import { useLibrarySearchStore, type LibraryTab } from "@/stores/library-search";
import { Gamepad2, Hammer, Image, Package, Search } from "lucide-react";
import {
  captureStoryReturnContext,
  navigateToStoryReturn,
  type StoryReturnContext,
} from "@/lib/story-return";
import { navigateBackSafely } from "@/lib/safe-back";

export function LibraryPage() {
  const { t } = useTranslation("library");
  const worlds = useWorldsStore(s => s.worlds);
  const loading = useWorldsStore(s => s.loading);
  const fetchWorlds = useWorldsStore(s => s.fetchWorlds);
  const libraryLoading = useLibraryStore(s => s.loading);
  const fetchLibrary = useLibraryStore(s => s.fetchLibrary);
  const { data: session } = useSession();
  const { isAuthenticated } = useAuthGuard();
  const {
    worldId: searchWorldId,
    view,
    assetId,
    returnTo,
    returnKey,
  } = useSearch({ from: "/app/library" });
  const navigate = useNavigate();
  const router = useRouter();
  const [selectedItem, setSelectedItem] = useState<WorldItem | null>(null);
  const detailReturnContext = useRef<StoryReturnContext | null>(
    searchWorldId ? { returnTo, returnKey } : null,
  );
  const detailSearchWorldId = useRef(searchWorldId);
  const searchQuery = useLibrarySearchStore((s) => s.query);
  const setSearchQuery = useLibrarySearchStore((s) => s.setQuery);
  const activeTab = useLibrarySearchStore((s) => s.activeTab);
  const setActiveTab = useLibrarySearchStore((s) => s.setActiveTab);
  const { features } = useEdition();
  // Games (hub library) and Bundles are hosted tabs; without them My Projects is home.
  const hiddenTabs = new Set<LibraryTab>([
    ...(features.library ? [] : (["games"] as LibraryTab[])),
    ...(features.bundles ? [] : (["bundle"] as LibraryTab[])),
  ]);
  const defaultViewRequestId = useLibrarySearchStore((s) => s.defaultViewRequestId);
  const previousDefaultViewRequestId = useRef(defaultViewRequestId);
  const fetchProfile = useUserProfileStore((s) => s.fetchProfile);
  const userId = session?.user?.id ?? "";
  const showNsfw = useUserProfileStore((s) => {
    const prefs = s.profile?.preferences;
    const cl = prefs?.contentLevel as string | undefined;
    // After 60fc8321: "r18" / "r18g" → "sensitive". Keep legacy compat for
    // any cookies / state that haven't roundtripped through the server yet.
    if (cl === "sensitive" || cl === "r18" || cl === "r18g") return true;
    // Backward compat: legacy showNsfw boolean (before contentLevel migration)
    if (!cl && prefs?.showNsfw === true) return true;
    return false;
  });

  useEffect(() => {
    if (isAuthenticated) {
      fetchWorlds();
      fetchLibrary();
      fetchProfile();
    }
  }, [isAuthenticated, fetchWorlds, fetchLibrary, fetchProfile]);

  // Sync tab + selection when the URL `view` param changes mid-session
  // (e.g. the session-export modal navigates to ?view=assets&assetId=…).
  // Without this, the tab state is frozen at mount time.
  useEffect(() => {
    if (view === "assets") {
      setActiveTab("assets");
      setSelectedItem(null);
    }
  }, [setActiveTab, view]);

  useEffect(() => {
    if (previousDefaultViewRequestId.current === defaultViewRequestId) return;
    previousDefaultViewRequestId.current = defaultViewRequestId;
    setActiveTab(features.library ? "games" : "projects");
    setSelectedItem(null);
  }, [defaultViewRequestId, setActiveTab, features.library]);

  const searchSelectedItem = useMemo(() => {
    if (!searchWorldId || loading || worlds.length === 0 || !session?.user?.id) return null;
    return worlds.find((world) => world.id === searchWorldId) ?? null;
  }, [searchWorldId, loading, worlds, session?.user?.id]);

  useEffect(() => {
    if (detailSearchWorldId.current === searchWorldId) return;
    detailSearchWorldId.current = searchWorldId;
    if (searchWorldId) {
      detailReturnContext.current = { returnTo, returnKey };
    }
  }, [returnKey, returnTo, searchWorldId]);

  const effectiveSelectedItem = selectedItem ?? searchSelectedItem;
  const effectiveActiveTab: LibraryTab = searchSelectedItem
    ? searchSelectedItem.creatorId === userId
      ? "projects"
      : "games"
    : hiddenTabs.has(activeTab)
      ? "projects"
      : activeTab;

  function handleRemixComplete(newWorld: WorldItem) {
    // Clear the URL search param so the auto-select effect doesn't
    // override selectedItem back to the old/source world after refetch.
    navigate({
      to: "/app/library",
      search: {
        worldId: newWorld.id,
        view: undefined,
        assetId: undefined,
        ...(detailReturnContext.current ?? {}),
      },
    });
    useWorldsStore.getState().invalidate();
    setActiveTab("projects");
    setSelectedItem(newWorld);
  }

  function handleSelectItem(item: WorldItem) {
    const returnContext = captureStoryReturnContext();
    detailReturnContext.current = returnContext;
    setSelectedItem(item);
    navigate({
      to: "/app/library",
      search: {
        worldId: item.id,
        view: undefined,
        assetId: undefined,
        ...returnContext,
      },
    });
  }

  function handleBackFromDetail() {
    setSelectedItem(null);
    navigateToStoryReturn(router.history, detailReturnContext.current ?? {});
    detailReturnContext.current = null;
  }

  // Determine which list to pass to the detail panel
  function getListForDetailPanel(): WorldItem[] {
    if (effectiveActiveTab === "games") {
      // Library items that have a corresponding world record
      const libraryItems = useLibraryStore.getState().items;
      const libraryWorldIds = new Set(libraryItems.map((li) => li.worldId));
      return worlds.filter((w) => libraryWorldIds.has(w.id));
    }
    if (effectiveActiveTab === "projects") {
      return worlds.filter((w) => w.creatorId === userId);
    }
    return [];
  }

  // Favorites view
  if (view === "favorites") {
    return (
      <LibraryFavoritesView
        worlds={worlds}
        onSelectItem={handleSelectItem}
        onBack={() => navigateBackSafely(router.history, "/app/library")}
      />
    );
  }

  // If an item is selected (Games or Projects), show the detail panel
  if (effectiveSelectedItem && (effectiveActiveTab === "games" || effectiveActiveTab === "projects")) {
    return (
      <LibraryDetailPanel
        selectedItem={effectiveSelectedItem}
        allItems={getListForDetailPanel()}
        onSelectItem={handleSelectItem}
        onBack={handleBackFromDetail}
        isProject={effectiveActiveTab === "projects"}
        onRemixComplete={handleRemixComplete}
        userId={userId}
      />
    );
  }

  const allTabs: { key: LibraryTab; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
    { key: "games", label: t("tabs.games"), icon: Gamepad2 },
    { key: "projects", label: t("tabs.myProjects"), icon: Hammer },
    { key: "assets", label: t("tabs.assets"), icon: Image },
    { key: "bundle", label: t("tabs.bundles"), icon: Package },
  ];
  const tabs = allTabs.filter((tab) => !hiddenTabs.has(tab.key));

  return (
    <div data-scroll-restoration-id="library-main" className="library-page-shell flex h-full w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
      {/* Header */}
      <div className="library-header-shell library-page-header border-b border-white/10 !pb-0">
        <div className="library-header-top flex w-full flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <h1 className="library-page-title text-4xl font-black text-foreground drop-shadow-lg">
              {t("page.title")}
            </h1>
          </div>

          <div className="library-header-search relative w-full md:max-w-[30rem]">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("page.searchPlaceholder")}
              className="w-full rounded-full border border-white/5 bg-white/5 py-3 pl-11 pr-4 text-sm text-foreground placeholder:text-muted-foreground/60 transition-all focus:border-white/10 focus:bg-white/10 focus:outline-none"
            />
          </div>
        </div>

        <nav className="library-tabs mt-5 w-full">
          {tabs.map((tab) => {
            return (
              <button
                key={tab.key}
                data-active={effectiveActiveTab === tab.key ? "true" : "false"}
                onClick={() => {
                  setActiveTab(tab.key);
                  setSelectedItem(null);
                  setSearchQuery("");
                  navigate({
                    to: "/app/library",
                    search: {
                      worldId: undefined,
                      view: tab.key === "assets" ? "assets" : undefined,
                      assetId: undefined,
                    },
                    replace: true,
                  });
                }}
                className={`group library-tab-button inline-flex items-center justify-center text-[14.5px] font-bold transition-all duration-300 border-b-2 ${effectiveActiveTab === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground/60 hover:text-foreground hover:border-white/30"
                  }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab Content */}
      {effectiveActiveTab === "games" && (
        <LibraryGameGrid
          searchQuery={searchQuery}
          onSelectItem={handleSelectItem}
          onRemixComplete={handleRemixComplete}
          showNsfw={showNsfw}
          userId={userId}
          loading={loading || libraryLoading}
        />
      )}

      {effectiveActiveTab === "projects" && (
        <LibraryMyProjects
          worlds={worlds}
          userId={userId}
          searchQuery={searchQuery}
          onSelectItem={handleSelectItem}
          loading={loading}
        />
      )}

      {effectiveActiveTab === "assets" && <LibraryAssetsTab highlightedAssetId={view === "assets" ? assetId : undefined} showBindingHint />}

      {effectiveActiveTab === "bundle" && <LibraryBundlesTab />}


    </div>
  );
}
