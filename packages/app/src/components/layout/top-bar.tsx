import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { scrollPageTo } from "@/lib/page-scroll";
import { installScrollAwayHeader } from "@/lib/scroll-away-header";
import {
  LogIn,
  User,
  Settings,
  LogOut,
  Search,
  CircleHelp,
  Menu,
} from "lucide-react";
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import {
  ContentLevelSwitcher,
  CreditIndicator,
  DmMessageIcon,
  NotificationBell,
  PartnerDashboardLink,
  useHubSearch,
  useIsWorldPreviewOpen,
} from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { getLandingRoute, getProfileRoute } from "@/edition/routes";
import { useLibrarySearchStore } from "@/stores/library-search";
import { useUserProfileStore } from "@/stores/user-profile";
import { useUiStore } from "@/stores/ui";
import { useCreatePageStore } from "@/stores/create-page";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { signOut, clearSessionCache } from "@/lib/auth-client";
import { getAvatarInitials } from "@/lib/avatar-initials";
import { DOCS_URLS } from "@/lib/docs-urls";

export function TopBarAccountControls() {
  const { t } = useTranslation();
  const { isAuthenticated, session } = useAuthGuard();
  const profile = useUserProfileStore((s) => s.profile);
  const { features, auth, edition } = useEdition();
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuDropdownRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  // Treat a cached profile as proof we're logged in. useSession() can flip
  // briefly to null during a re-fetch (mobile resume, network blip), and
  // tying the avatar to that raw state caused a visible flicker to the
  // "Login" button. signOut() clears the profile synchronously, so an
  // unauthenticated user never has profile set.
  const showAuthenticatedControls = isAuthenticated || !!profile;

  useLayoutEffect(() => {
    if (!showMenu || !menuButtonRef.current) return;
    const rect = menuButtonRef.current.getBoundingClientRect();
    const dropdownWidth = Math.min(192, window.innerWidth - 16);
    const idealLeft = rect.right - dropdownWidth;
    setMenuPos({
      top: rect.bottom + 4,
      left: Math.max(8, Math.min(idealLeft, window.innerWidth - dropdownWidth - 8)),
    });
  }, [showMenu]);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        menuDropdownRef.current && !menuDropdownRef.current.contains(target)
      ) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  const displayName = profile?.name ?? session?.user?.name ?? "User";
  const avatarSrc = profile?.image ?? session?.user?.image ?? undefined;
  const initials = getAvatarInitials(displayName);

  return (
    <div className="topbar-account-controls flex shrink-0 items-center gap-2">
      {/* Hosted-only chrome, each behind its edition feature (hidden, not disabled). */}
      {showAuthenticatedControls && features.referrals && <PartnerDashboardLink />}
      {features.hub && <ContentLevelSwitcher />}
      {showAuthenticatedControls && (
        <>
          {features.dm && <DmMessageIcon />}
          {features.notifications && <NotificationBell />}
        </>
      )}

      <a
        href={DOCS_URLS.home}
        target="_blank"
        rel="noopener noreferrer"
        className="topbar-account-help rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
        title={t("nav.help")}
      >
        <CircleHelp className="h-4 w-4" />
      </a>

      {showAuthenticatedControls && features.billing && <CreditIndicator />}

      <div className="topbar-account-divider mx-1 h-6 w-px bg-white/10" />

      {showAuthenticatedControls ? (
        <div className="relative" ref={menuRef}>
          {showMenu && menuPos && createPortal(
            <div
              ref={menuDropdownRef}
              className="fixed z-[9999] w-48 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-white/10 bg-card shadow-lg animate-in fade-in slide-in-from-top-2 duration-150"
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              {/* Hosted: the social profile. Local: the identity page (avatar, personas,
                  shortcuts). A hosted server without social profiles has neither, so the
                  Settings entry below is the account page. */}
              {(features.socialProfiles || edition === "local") && (
              <button
                onClick={() => {
                  setShowMenu(false);
                  router.navigate({ to: getProfileRoute() });
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-foreground/80 transition-colors hover:bg-white/5"
              >
                <User className="h-4 w-4 text-muted-foreground/60" />
                {t("nav.profile")}
              </button>
              )}
              <button
                onClick={() => {
                  setShowMenu(false);
                  router.navigate({ to: "/app/settings" });
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-foreground/80 transition-colors hover:bg-white/5"
              >
                <Settings className="h-4 w-4 text-muted-foreground/60" />
                {t("nav.settings")}
              </button>
              {/* Single-user mode has one auto-signed-in local account: nothing to sign out of. */}
              {auth.mode === "multi-user" && (
              <>
              <div className="mx-3 border-t border-white/5" />
              <button
                onClick={async () => {
                  setShowMenu(false);
                  clearSessionCache();
                  await signOut();
                  router.navigate({ to: getLandingRoute() });
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-white/5"
              >
                <LogOut className="h-4 w-4" />
                {t("nav.signOut")}
              </button>
              </>
              )}
            </div>,
            document.body
          )}

          <button
            ref={menuButtonRef}
            aria-expanded={showMenu}
            aria-haspopup="true"
            onClick={() => setShowMenu((v) => !v)}
            className="topbar-profile-button flex items-center gap-2 rounded-full border border-white/10 py-1 pl-1 pr-3 transition-colors hover:bg-white/5"
          >
            <Avatar className="h-7 w-7">
              <AvatarImage src={avatarSrc} />
              <AvatarFallback className="bg-primary/20 text-[10px] font-bold text-primary">
                {initials}
              </AvatarFallback>
            </Avatar>
            <span className="topbar-profile-label text-xs font-bold text-foreground">
              {displayName}
            </span>
          </button>
        </div>
      ) : auth.mode === "multi-user" ? (
        <Link
          to="/login"
          preload="intent"
          className="topbar-sign-in-button flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-foreground"
        >
          <LogIn className="h-4 w-4" />
          {t("nav.signIn")}
        </Link>
      ) : null}
    </div>
  );
}

export function TopBar() {
  const { t } = useTranslation();
  const { query: hubQuery, setQuery: setHubQuery } = useHubSearch();
  const libraryQuery = useLibrarySearchStore((s) => s.query);
  const setLibraryQuery = useLibrarySearchStore((s) => s.setQuery);
  const isWorldPreviewOpen = useIsWorldPreviewOpen();
  const location = useLocation();
  const headerRef = useRef<HTMLDivElement>(null);
  const [scrollHidden, setScrollHidden] = useState(false);

  const isDiscoverPage = location.pathname.startsWith("/app/hub");
  const isLibraryPage = location.pathname.startsWith("/app/library");
  const isCommunityPage = location.pathname.startsWith("/app/community");
  const isMessagesPage = location.pathname.startsWith("/app/messages");
  const isProfilePage =
    location.pathname.startsWith("/app/profile") || location.pathname.startsWith("/app/users");
  const showSearch = isDiscoverPage || isLibraryPage;
  const isCreatePage = location.pathname.startsWith("/app/worlds/create");
  const isPickerActive = useCreatePageStore((s) => s.isPickerActive);
  const isCreatePicker = isCreatePage && isPickerActive;
  const isEditPage =
    location.pathname.match(/^\/app\/worlds\/.*\/edit/) || location.pathname.startsWith("/app/studio")
    // The generation page draws its own header band; the app bar on top of it
    // read as two headers.
    || location.pathname === "/app/generate";
  const isPlayPage =
    location.pathname.startsWith("/app/chat/") || location.pathname.startsWith("/app/preview/");
  const isAdminWorldInspect = location.pathname.startsWith("/app/admin/world-inspect/");
  const toggleMobileNav = useUiStore((s) => s.toggleMobileNav);

  useEffect(() => {
    const header = headerRef.current;
    if (!header || (!isDiscoverPage && !isCommunityPage && !isLibraryPage && !isMessagesPage && !isCreatePicker)) return;
    return installScrollAwayHeader(window, header, setScrollHidden);
  }, [location.pathname, isDiscoverPage, isCommunityPage, isLibraryPage, isMessagesPage, isCreatePicker]);

  const handleDiscoverSearchConfirm = () => {
    const hubScroller = document.querySelector(".hub-layout-scroll") as HTMLElement | null;
    scrollPageTo(hubScroller, 0);
  };

  const searchValue = isLibraryPage ? libraryQuery : hubQuery;
  const searchPlaceholder = isLibraryPage ? t("search.library") : t("search.hub");
  const setSearchValue = isLibraryPage ? setLibraryQuery : setHubQuery;

  if (isEditPage || (isCreatePage && !isCreatePicker) || isPlayPage || isAdminWorldInspect) return null;

  return (
    <div
      ref={headerRef}
      // Safari retains the native top fill of hidden HTML <header> elements.
      // Keep the landmark without retaining that fill after navigation hides.
      role="banner"
      data-scroll-hidden={scrollHidden || undefined}
      data-preview-open={isWorldPreviewOpen || undefined}
      inert={isWorldPreviewOpen || scrollHidden}
      aria-hidden={isWorldPreviewOpen || scrollHidden || undefined}
      className={`topbar-shell z-50 flex shrink-0 bg-transparent ${
        showSearch ? "topbar-shell--search" : ""
      } ${
        isDiscoverPage ? "topbar-shell--discover" : ""
      } ${isLibraryPage ? "topbar-shell--library" : ""} ${
        isCommunityPage ? "topbar-shell--community" : ""
      } ${
        isProfilePage ? "topbar-shell--profile" : ""
      } ${
        isCreatePicker ? "topbar-shell--create-picker" : ""
      }`}
    >
      <div className="topbar-inner hub-container">
        <div className="topbar-row">
          <div className="topbar-start">
            <button
              type="button"
              data-mobile-nav-trigger
              onClick={toggleMobileNav}
              className="topbar-mobile-trigger rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              title={t("aria.openNav")}
              aria-label={t("aria.openNav")}
            >
              <Menu className="h-4 w-4" />
            </button>
          </div>

          <div className="topbar-center topbar-search-region">
            {showSearch ? (
              <div className="topbar-search-glass group relative w-full">
                <Search className="topbar-search-icon pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
                <input
                  type="search"
                  placeholder={searchPlaceholder}
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter" && isDiscoverPage) {
                      handleDiscoverSearchConfirm();
                      e.currentTarget.blur();
                    }
                  }}
                  className="topbar-search-input topbar-search-input--glass w-full rounded-full border border-white/5 bg-white/5 pl-11 pr-4 text-sm text-foreground placeholder:text-muted-foreground/60 transition-all focus:border-white/10 focus:bg-white/10 focus:outline-none"
                />
              </div>
            ) : null}
          </div>

          <div className="topbar-end">
            <TopBarAccountControls />
          </div>
        </div>
      </div>
    </div>
  );
}
