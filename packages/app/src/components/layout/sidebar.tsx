import { useState, useEffect, useRef } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { Compass, UserCircle, Plus, Library, ChevronRight, X, Clock3, Shield, LayoutList, MessageSquare, Download, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SidebarNavItem } from "./sidebar-nav-item";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { useUiStore } from "@/stores/ui";
import { useWorldsStore } from "@/stores/worlds";
import { useUserProfileStore } from "@/stores/user-profile";
import { useCreditStore } from "@/edition/slots.state";
import { useEdition, useIsLocalEdition } from "@/edition/edition";
import { HOSTED_ROUTES } from "@/edition/routes";
import { MushroomIcon } from "@/lib/plan-theme";
import { floorMushies } from "@/lib/format-mushies";
import { useLibrarySearchStore } from "@/stores/library-search";
import { isIOS } from "@/hooks/use-touch-device";
import { feedback } from "@/lib/feedback";
import { useTranslation } from "react-i18next";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

/** What has to be on for a nav item to exist (resolved per edition below); null = always. */
type NavGate = "hub" | "community" | "profile";
const navItems: {
  to: string;
  labelKey: "nav.discover" | "nav.community" | "nav.library" | "nav.profile";
  icon: typeof Compass;
  gate: NavGate | null;
}[] = [
  { to: HOSTED_ROUTES.hub, labelKey: "nav.discover", icon: Compass, gate: "hub" },
  { to: HOSTED_ROUTES.community, labelKey: "nav.community", icon: MessageSquare, gate: "community" },
  { to: "/app/library", labelKey: "nav.library", icon: Library, gate: null },
  // Hosted: the social profile. Local: the identity page (avatar, personas, shortcuts).
  { to: "/app/profile", labelKey: "nav.profile", icon: UserCircle, gate: "profile" },
];

export function Sidebar() {
  const location = useLocation();
  const router = useRouter();
  const { isAuthenticated, requireAuth } = useAuthGuard();
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen);
  const closeMobileNav = useUiStore((s) => s.closeMobileNav);
  const recentPlayedWorlds = useUiStore((s) => s.recentPlayedWorlds);
  const removeRecentPlayedWorld = useUiStore((s) => s.removeRecentPlayedWorld);
  const worlds = useWorldsStore((s) => s.worlds);
  const profile = useUserProfileStore((s) => s.profile);
  const plan = useCreditStore((s) => s.plan);
  const balance = useCreditStore((s) => s.balance);
  const { features } = useEdition();
  const isLocalEdition = useIsLocalEdition();
  const showsProfile = features.socialProfiles || isLocalEdition;
  const navGates: Record<NavGate, boolean> = {
    hub: features.hub,
    community: features.community,
    profile: showsProfile,
  };
  const visibleNavItems = navItems.filter((item) => item.gate === null || navGates[item.gate]);
  const requestLibraryDefaultView = useLibrarySearchStore((s) => s.requestDefaultView);
  const isAdmin = profile?.role === "admin";
  const showsYuminaBrandMark =
    !isAuthenticated ||
    !profile?.image ||
    profile.name.trim().toLowerCase() === "yumina" ||
    /(?:^|\/)logo\.png(?:[?#]|$)/i.test(profile.image);
  const { t, i18n } = useTranslation();
  const compactBalance = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(floorMushies(balance));
  const [brokenRecentThumbs, setBrokenRecentThumbs] = useState<string[]>([]);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const mobileNavDrawerRef = useRef<HTMLElement>(null);
  const mobileNavCloseButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavReturnFocusRef = useRef<HTMLElement | null>(null);
  const mobileNavShouldRestoreFocusRef = useRef(true);
  const wasMobileNavOpenRef = useRef(false);
  const isPlayPage = location.pathname.startsWith("/app/chat/") || location.pathname.startsWith("/app/preview/");
  const isStandalone =
    typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true);
  const navigateToLibraryDefault = () => {
    requestLibraryDefaultView();
    void router.navigate({
      to: "/app/library",
      search: { worldId: undefined, view: undefined, assetId: undefined },
    });
  };

  function resolveRecentThumbnail(world: { id: string; thumbnailUrl: string | null }) {
    const liveWorld = worlds.find((item) => item.id === world.id);
    const schemaAvatar =
      typeof liveWorld?.schema?.avatar === "string" ? (liveWorld.schema.avatar as string) : null;

    return liveWorld?.thumbnailUrl ?? schemaAvatar ?? world.thumbnailUrl ?? null;
  }

  useEffect(() => {
    if (!mobileNavOpen) return;

    const desktopQuery = window.matchMedia("(min-width: 768px)");
    if (desktopQuery.matches) {
      closeMobileNav();
      return;
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== document.body) {
      mobileNavReturnFocusRef.current = activeElement;
    }

    const appContent = document.querySelector<HTMLElement>(".app-shell-content");
    const previousAriaHidden = appContent?.getAttribute("aria-hidden") ?? null;
    const previousInert = appContent?.inert ?? false;
    if (appContent) {
      appContent.setAttribute("aria-hidden", "true");
      appContent.inert = true;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMobileNav();
        return;
      }

      if (event.key !== "Tab") return;

      const drawer = mobileNavDrawerRef.current;
      if (!drawer) return;

      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((target) => target.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }

      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !drawer.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !drawer.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleDesktopChange = (event: MediaQueryListEvent) => {
      if (event.matches) closeMobileNav();
    };

    document.addEventListener("keydown", handleKeyDown);
    desktopQuery.addEventListener("change", handleDesktopChange);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      desktopQuery.removeEventListener("change", handleDesktopChange);
      if (!appContent?.isConnected) return;
      if (previousAriaHidden === null) appContent.removeAttribute("aria-hidden");
      else appContent.setAttribute("aria-hidden", previousAriaHidden);
      appContent.inert = previousInert;
    };
  }, [mobileNavOpen, closeMobileNav]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setInstallPrompt(null);
      feedback.notice(t("installApp.installed"));
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, [t]);

  useEffect(() => {
    closeMobileNav();
  }, [location.pathname, location.searchStr, closeMobileNav]);

  useEffect(() => {
    const wasOpen = wasMobileNavOpenRef.current;

    if (mobileNavOpen && !wasOpen) {
      const activeElement = document.activeElement;
      if (
        !mobileNavReturnFocusRef.current &&
        activeElement instanceof HTMLElement &&
        activeElement !== document.body
      ) {
        mobileNavReturnFocusRef.current = activeElement;
      }
      mobileNavCloseButtonRef.current?.focus({ preventScroll: true });
    } else if (!mobileNavOpen && wasOpen) {
      const returnTarget = mobileNavReturnFocusRef.current;
      if (mobileNavShouldRestoreFocusRef.current) {
        const visibleReturnTarget =
          returnTarget?.isConnected && returnTarget.getClientRects().length > 0
            ? returnTarget
            : Array.from(
                document.querySelectorAll<HTMLElement>(
                  '[data-mobile-nav-trigger], [aria-label="Open navigation"]'
                )
              ).find((target) => target.getClientRects().length > 0);
        visibleReturnTarget?.focus({ preventScroll: true });
      }
      mobileNavShouldRestoreFocusRef.current = true;
      mobileNavReturnFocusRef.current = null;
    }

    wasMobileNavOpenRef.current = mobileNavOpen;
  }, [mobileNavOpen]);

  const handleInstallApp = async () => {
    // The nav item hides itself once isStandalone is true (nothing left to
    // guide the user toward), so this is just a safety no-op.
    if (isStandalone) return;

    if (installPrompt) {
      const prompt = installPrompt;
      setInstallPrompt(null);
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") {
        feedback.notice(t("installApp.installed"));
      }
      // Declining the browser's own prompt is confirmation enough — the
      // dialog closing is the visible result.
      return;
    }

    // No native prompt available (iOS/Safari, unsupported browsers) — this
    // is how-to instruction, not a quick confirmation, so it stays until closed.
    feedback.persistent(
      isIOS() ? t("installApp.iosInstructions") : t("installApp.browserInstructions"),
      { label: t("action.close"), onClick: () => {} },
    );
  };

  const handleRefreshPage = () => {
    window.location.reload();
  };

  return (
    <>
      <div className="desktop-sidebar-rail">
        <aside className="sidebar-shell">
          <div className="sidebar-logo-wrap">
            <div className="group flex flex-col items-center">
              <div className="sidebar-logo-mark" aria-label="Yumina">
                <span className="sidebar-logo-mark__glow" aria-hidden />
                <img src="/logo.png" alt="Yumina" />
              </div>
              <span
                aria-hidden="true"
                className="-mt-0.5 select-none text-[10px] font-medium lowercase tracking-[0.18em] text-[#C9A25E]/70 transition-colors duration-300 group-hover:text-[#F5E6B8]"
              >
                yumina
              </span>
            </div>
          </div>

          <nav className="sidebar-nav" aria-label={t("mobile.browse")}>
            <SidebarNavItem
              to="/app/worlds/create"
              label={t("nav.create")}
              icon={Plus}
              isActive={location.pathname.startsWith("/app/worlds/create")}
            />

            {visibleNavItems.map((item) => {
              const isActive = location.pathname.startsWith(item.to);

              if (!isAuthenticated && item.gate === "profile") {
                return (
                  <SidebarNavItem
                    key={item.to}
                    label={t(item.labelKey)}
                    icon={item.icon}
                    isActive={isActive}
                    onClick={() => requireAuth("save worlds to your library")}
                  />
                );
              }

              if (item.to === "/app/library") {
                return (
                  <SidebarNavItem
                    key={item.to}
                    label={t(item.labelKey)}
                    icon={item.icon}
                    isActive={isActive}
                    onClick={navigateToLibraryDefault}
                  />
                );
              }

              return (
                <SidebarNavItem
                  key={item.to}
                  to={item.to}
                  label={t(item.labelKey)}
                  icon={item.icon}
                  isActive={isActive}
                />
              );
            })}

            {isAdmin && features.admin && (
              <SidebarNavItem
                to={HOSTED_ROUTES.admin}
                label={t("nav.admin")}
                icon={Shield}
                isActive={location.pathname.startsWith("/app/admin")}
              />
            )}
          </nav>
        </aside>
      </div>

      {!isPlayPage && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeMobileNav}
            className={cn(
              "mobile-nav-backdrop md:hidden",
              mobileNavOpen ? "mobile-nav-backdrop--open" : "mobile-nav-backdrop--closed"
            )}
          />

          <aside
            ref={mobileNavDrawerRef}
            className={cn(
              "mobile-nav-drawer md:hidden",
              mobileNavOpen ? "mobile-nav-drawer--open" : "mobile-nav-drawer--closed"
            )}
            aria-hidden={!mobileNavOpen}
            aria-label={t("mobile.browse")}
            aria-modal="true"
            inert={!mobileNavOpen}
            role="dialog"
          >
            <div className="mobile-nav-drawer__header">
              <div className="mobile-nav-drawer__identity">
                {showsYuminaBrandMark ? (
                  <img
                    src={isAuthenticated && profile?.image ? profile.image : "/logo.png"}
                    alt="Yumina"
                    className="mobile-nav-drawer__brand-logo"
                  />
                ) : (
                  <div className="mobile-nav-drawer__avatar">
                    <img src={profile!.image!} alt="" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="mobile-nav-drawer__identity-name">
                    {isAuthenticated ? profile?.name ?? t("nav.profile") : t("mobile.menu")}
                  </p>
                  {isAuthenticated && features.billing ? (
                    <p className="mobile-nav-drawer__identity-meta">
                      <span className="truncate">{plan ? t(`planName.${plan}` as never) : t("planName.free")}</span>
                      <span aria-hidden="true">·</span>
                      <MushroomIcon className="h-3 w-3 text-gold/70" />
                      <span className="tabular-nums">{compactBalance}</span>
                    </p>
                  ) : (
                    <p className="mobile-nav-drawer__identity-meta">Yumina</p>
                  )}
                </div>
              </div>
              <button
                ref={mobileNavCloseButtonRef}
                type="button"
                onClick={closeMobileNav}
                className="mobile-nav-drawer__close"
                aria-label={t("aria.closeNav")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mobile-nav-drawer__welcome">
              <span>{t("mobile.browse")}</span>
            </div>
            <nav
              className="mobile-nav-drawer__list"
              aria-label={t("mobile.browse")}
              onClickCapture={() => {
                // Close even when selecting the current route. Do not focus
                // the old toolbar while a new page is being installed.
                mobileNavShouldRestoreFocusRef.current = false;
                closeMobileNav();
              }}
            >
              <button
                type="button"
                onClick={() => router.navigate({ to: "/app/worlds/create" })}
                className={cn(
                  "mobile-nav-drawer__item mobile-nav-drawer__item--create",
                  location.pathname.startsWith("/app/worlds/create") && "mobile-nav-drawer__item--active"
                )}
              >
                <span className="mobile-nav-drawer__item-icon">
                  <Plus className="h-4.5 w-4.5" />
                </span>
                <span className="mobile-nav-drawer__item-copy">
                  <span className="mobile-nav-drawer__item-label">{t("nav.create")}</span>
                </span>
                <ChevronRight className="mobile-nav-drawer__item-arrow" />
              </button>

              {features.hub && (
              <button
                type="button"
                onClick={() => router.navigate({ to: HOSTED_ROUTES.hub })}
                className={cn(
                  "mobile-nav-drawer__item",
                  location.pathname.startsWith("/app/hub") && "mobile-nav-drawer__item--active"
                )}
              >
                <span className="mobile-nav-drawer__item-icon">
                  <Compass className="h-4.5 w-4.5" />
                </span>
                <span className="mobile-nav-drawer__item-copy">
                  <span className="mobile-nav-drawer__item-label">{t("nav.discover")}</span>
                </span>
                <ChevronRight className="mobile-nav-drawer__item-arrow" />
              </button>
              )}

              {features.community && (
              <button
                type="button"
                onClick={() => router.navigate({ to: HOSTED_ROUTES.community })}
                className={cn(
                  "mobile-nav-drawer__item",
                  location.pathname.startsWith("/app/community") && "mobile-nav-drawer__item--active"
                )}
              >
                <span className="mobile-nav-drawer__item-icon">
                  <MessageSquare className="h-4.5 w-4.5" />
                </span>
                <span className="mobile-nav-drawer__item-copy">
                  <span className="mobile-nav-drawer__item-label">{t("nav.community")}</span>
                </span>
                <ChevronRight className="mobile-nav-drawer__item-arrow" />
              </button>
              )}

              <button
                type="button"
                onClick={navigateToLibraryDefault}
                className={cn(
                  "mobile-nav-drawer__item",
                  location.pathname.startsWith("/app/library") && "mobile-nav-drawer__item--active"
                )}
              >
                <span className="mobile-nav-drawer__item-icon">
                  <Library className="h-4.5 w-4.5" />
                </span>
                <span className="mobile-nav-drawer__item-copy">
                  <span className="mobile-nav-drawer__item-label">{t("nav.library")}</span>
                </span>
                <ChevronRight className="mobile-nav-drawer__item-arrow" />
              </button>

              {showsProfile && (
              <button
                type="button"
                onClick={() => {
                  if (isAuthenticated) {
                    router.navigate({ to: "/app/profile" });
                    return;
                  }
                  mobileNavShouldRestoreFocusRef.current = false;
                  closeMobileNav();
                  window.requestAnimationFrame(() => {
                    const visibleNavTrigger = Array.from(
                      document.querySelectorAll<HTMLElement>(
                        '[data-mobile-nav-trigger], [aria-label="Open navigation"]'
                      )
                    ).find((target) => target.getClientRects().length > 0);
                    visibleNavTrigger?.focus();
                    requireAuth("save worlds to your library");
                  });
                }}
                className={cn(
                  "mobile-nav-drawer__item",
                  location.pathname.startsWith("/app/profile") && "mobile-nav-drawer__item--active"
                )}
              >
                <span className="mobile-nav-drawer__item-icon">
                  <UserCircle className="h-4.5 w-4.5" />
                </span>
                <span className="mobile-nav-drawer__item-copy">
                  <span className="mobile-nav-drawer__item-label">{t("nav.profile")}</span>
                </span>
                <ChevronRight className="mobile-nav-drawer__item-arrow" />
              </button>
              )}

              {/* Admin — mobile */}
              {isAdmin && features.admin && (
                <button
                  type="button"
                  onClick={() => router.navigate({ to: HOSTED_ROUTES.admin })}
                  className={cn(
                    "mobile-nav-drawer__item",
                    location.pathname.startsWith("/app/admin") && "mobile-nav-drawer__item--active"
                  )}
                >
                  <span className="mobile-nav-drawer__item-icon">
                    <Shield className="h-4.5 w-4.5" />
                  </span>
                  <span className="mobile-nav-drawer__item-copy">
                    <span className="mobile-nav-drawer__item-label">{t("nav.admin")}</span>
                  </span>
                  <ChevronRight className="mobile-nav-drawer__item-arrow" />
                </button>
              )}
            </nav>

            <div className="mobile-nav-drawer__recent">
              <div className="mobile-nav-drawer__recent-header">
                <Clock3 className="h-4 w-4 text-primary/80" />
                <span>{t("mobile.recentWorlds")}</span>
              </div>

              {recentPlayedWorlds.length > 0 ? (
                <div
                  className="mobile-nav-drawer__recent-list"
                  role="region"
                  aria-label={t("mobile.recentWorlds")}
                >
                  {recentPlayedWorlds.slice(0, 5).map((world) => (
                    <div key={world.id} className="mobile-nav-drawer__recent-item">
                      <button
                        type="button"
                        onClick={() =>
                          router.navigate({
                            to: "/app/library",
                            search: { worldId: world.id, view: undefined, assetId: undefined },
                          })
                        }
                        className="mobile-nav-drawer__recent-open flex min-w-0 flex-1 items-center gap-[0.65rem] text-left"
                      >
                        <div className="mobile-nav-drawer__recent-thumb">
                          {(() => {
                            const resolvedThumbnail = resolveRecentThumbnail(world);
                            const canShowImage =
                              !!resolvedThumbnail && !brokenRecentThumbs.includes(resolvedThumbnail);

                            return canShowImage ? (
                            <img
                              src={resolvedThumbnail}
                              alt={world.name}
                              className="h-full w-full object-cover"
                              onError={() =>
                                setBrokenRecentThumbs((current) =>
                                  current.includes(resolvedThumbnail)
                                    ? current
                                    : [...current, resolvedThumbnail]
                                )
                              }
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-white/[0.04] text-xs font-bold text-primary/70">
                              {world.name.charAt(0).toUpperCase()}
                            </div>
                            );
                          })()}
                        </div>
                        <div className="mobile-nav-drawer__recent-copy">
                          <p className="truncate text-sm font-semibold text-foreground">{world.name}</p>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeRecentPlayedWorld(world.id)}
                        className="mobile-nav-drawer__recent-remove flex shrink-0 items-center justify-center rounded-lg text-muted-foreground/40 transition-colors active:bg-white/[0.08] active:text-foreground"
                        title={t("mobile.removeRecent")}
                        aria-label={t("mobile.removeRecent")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mobile-nav-drawer__recent-empty">
                  {t("mobile.recentEmpty")}
                </p>
              )}

            </div>

            <div className="mobile-nav-drawer__utilities">
              <button
                type="button"
                onClick={() => {
                  closeMobileNav();
                  useUiStore.getState().openSessionManager();
                }}
                className="mobile-nav-drawer__utility"
              >
                <LayoutList className="h-4 w-4" />
                <span>{t("mobile.manageSessions")}</span>
              </button>
              {!isStandalone && (
                <button type="button" onClick={handleInstallApp} className="mobile-nav-drawer__utility">
                  <Download className="h-4 w-4" />
                  <span>{t("nav.installApp")}</span>
                </button>
              )}
              <button type="button" onClick={handleRefreshPage} className="mobile-nav-drawer__utility">
                <RotateCw className="h-4 w-4" />
                <span>{t("action.refresh")}</span>
              </button>
            </div>
          </aside>
        </>
      )}
    </>
  );
}
