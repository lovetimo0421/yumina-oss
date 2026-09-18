import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useImmersiveMode } from "@/hooks/use-fullscreen";
import { useBrowseEngagement } from "@/hooks/use-browse-engagement";
import { useLocation } from "@tanstack/react-router";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { Toaster } from "@/components/ui/sonner";
import { useUserProfileStore } from "@/stores/user-profile";
import { useSession } from "@/lib/auth-client";
import { useSyncLanguage } from "@/hooks/use-sync-language";
import { useCreatePageStore } from "@/stores/create-page";
import { useUiStore, FONT_SIZE_SCALE } from "@/stores/ui";
import { setWorldAudioEnabled } from "@/stores/audio";
import { getAssetCdnUrl } from "@/lib/asset-url";
import { PlaySessionPickerHost } from "@/hooks/use-play-with-language";
import { PersistentChat } from "./persistent-chat";
import { useExtensionsStore } from "@/stores/extensions";
import {
  HostedShellModals,
  HostedShellOverlays,
  hostedShellModalImporters,
  useHostedShellEffects,
} from "@/edition/slots";
import { rememberDmReturnPath } from "@/edition/slots.state";
import { installMobileViewport } from "@/lib/mobile-viewport";
import { installOverlayRecovery } from "@/lib/overlay-recovery";
import { installReadingPageCanvas } from "@/lib/reading-page-canvas";
import { getMobileReadingPageId } from "@/lib/mobile-reading-route";

// Globally-mounted modals are render-on-demand (zustand stores drive their
// visibility), so their feature trees don't belong in the entry chunk. Lazy
// chunks + an idle-time prefetch below: first paint ships less JS, and the
// chunks are warm long before anyone can click something that opens them.
// Hosted-only modals (invite, world preview, bundle preview) live behind the
// edition seam as <HostedShellModals /> + hostedShellModalImporters.
const modalImporters = {
  AuthModal: () => import("@/features/auth/auth-modal"),
  SessionManagerModal: () => import("@/features/sessions/session-manager-modal"),
  ExtensionPreviewModal: () => import("@/features/extensions/extension-preview-modal"),
} as const;
const AuthModal = lazy(() => modalImporters.AuthModal().then((m) => ({ default: m.AuthModal })));
const SessionManagerModal = lazy(() => modalImporters.SessionManagerModal().then((m) => ({ default: m.SessionManagerModal })));
const ExtensionPreviewModal = lazy(() => modalImporters.ExtensionPreviewModal().then((m) => ({ default: m.ExtensionPreviewModal })));

function prefetchShellModals(): void {
  // bind() — an unbound requestIdleCallback throws "Illegal invocation".
  const idle = typeof window.requestIdleCallback === "function"
    ? window.requestIdleCallback.bind(window)
    : (cb: () => void) => window.setTimeout(cb, 1_500);
  idle(() => {
    for (const importer of [...Object.values(modalImporters), ...hostedShellModalImporters]) {
      importer().catch(() => {
        /* prefetch only — the lazy boundary retries on first open */
      });
    }
  });
}
import { captureHubEvent, identifyAnalyticsUser, resetAnalyticsUser, maybeTrackSignupFromCreatedAt, trackActiveUserPixel } from "@/lib/analytics";
import { useConfigStore } from "@/stores/config";
import { BlockedDialogHost } from "@/lib/blocked-feedback";
import { getDesktopSidebarOffset } from "@/lib/desktop-sidebar-layout";

interface AppShellProps {
  children: ReactNode;
}

type WallpaperPreset = "starry-night" | "library-canvas";
type WallpaperChoice = WallpaperPreset | string;
type WallpaperPage = "discover" | "profile" | "settings" | "library" | "community" | "messages";

function getWallpaperOpacityScale(preference: unknown) {
  const parsed = typeof preference === "number" ? preference : Number(preference);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(2, Math.max(0, parsed / 100));
}

function getVisualStrength(preference: unknown, fallback = 100) {
  const parsed = typeof preference === "number" ? preference : Number(preference);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(200, Math.max(0, Math.round(parsed)));
}

function getScaledWallpaperOpacity(baseOpacity: number, scale: number) {
  return Math.min(1, Math.max(0, baseOpacity * scale));
}

function getGradientOverlay(scale: number) {
  const bottom = getScaledWallpaperOpacity(0.8, scale);
  const middle = getScaledWallpaperOpacity(0.5, scale);
  const top = getScaledWallpaperOpacity(0.2, scale);
  return `linear-gradient(to top, rgba(11, 15, 25, ${bottom}), rgba(18, 18, 18, ${middle}), rgba(18, 18, 18, ${top}))`;
}

function isWallpaperPreset(value: unknown): value is WallpaperPreset {
  return value === "library-canvas" || value === "starry-night";
}

function normalizeWallpaperChoice(value: unknown, fallback: WallpaperChoice): WallpaperChoice {
  if (typeof value !== "string") return fallback;
  if (isWallpaperPreset(value)) return value;
  if (value.startsWith("@asset:")) return value;
  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/")) {
    return value;
  }
  return fallback;
}

function getWallpaperSrc(choice: WallpaperChoice) {
  if (choice === "library-canvas") return "/libary-bg.jpg";
  if (choice === "starry-night") return "/starry-night-bg.jpg";
  if (choice.startsWith("@asset:")) return getAssetCdnUrl(choice.slice(7));
  return choice;
}

function getWallpaperBaseOpacity(page: WallpaperPage) {
  // Community + Library share the same default wallpaper image, so they must
  // match in brightness. Library used to render noticeably darker at 0.55 —
  // unify both on the brighter "open" community value.
  if (page === "community" || page === "library") return 0.72;
  // Profile / settings / messages keep the unified darker opacity.
  return 0.55;
}

function getAtmosphereClass(pathname: string) {
  if (pathname.startsWith("/app/hub") || pathname.startsWith("/app/profile") || pathname.startsWith("/app/users") || pathname.startsWith("/app/settings") || pathname.startsWith("/app/extensions")) return "atmosphere-vibrant";
  if (pathname.match(/\/app\/worlds\/[^/]+\/edit/) || pathname.startsWith("/app/studio") || pathname === "/app/worlds/create")
    return "atmosphere-none";
  return "atmosphere-subtle";
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const atmosphereClass = getAtmosphereClass(location.pathname);
  const isPickerActive = useCreatePageStore((s: { isPickerActive: boolean }) => s.isPickerActive);
  const isCreatePagePicker = location.pathname === "/app/worlds/create" && isPickerActive;
  const isPlayPage = location.pathname.startsWith("/app/chat/") || location.pathname.startsWith("/app/preview/");
  const theaterMode = useUiStore((s) => s.theaterMode);
  const isAdminWorldInspect = location.pathname.startsWith("/app/admin/world-inspect/");
  const isAdminPage = location.pathname === "/app/admin" || location.pathname.startsWith("/app/admin/");
  const enableMobilePageScroll = !isPlayPage && !isCreatePagePicker && !location.pathname.startsWith("/app/studio") && !isAdminPage;
  const { toggle: toggleImmersive } = useImmersiveMode();

  // Dedicated messages replaces the URL while switching conversations, so a
  // browser Back cannot reliably recover the page that originally opened it.
  // Keep the latest non-DM route per tab and let the page exit directly there.
  // Capture before the next click, using one router snapshot. Native history
  // may still point at the previous page until TanStack flushes its update.
  useLayoutEffect(() => {
    if (location.pathname.startsWith("/app/messages")) return;
    rememberDmReturnPath(location.href, location.state.__TSR_index);
  }, [location.href, location.pathname, location.state.__TSR_index]);

  // Exit immersive mode when navigating away from play pages
  useEffect(() => {
    if (!isPlayPage && theaterMode) {
      toggleImmersive();
    }
  }, [isPlayPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync the account "world audio" preference into the audio store kill
  // switch (absent = on, so existing users keep current behavior).
  const worldAudioEnabled = useUserProfileStore(
    (s) => s.profile?.preferences?.worldAudioEnabled !== false,
  );
  useEffect(() => {
    setWorldAudioEnabled(worldAudioEnabled);
  }, [worldAudioEnabled]);

  // Reset app-shell-root scroll when theater mode changes — entering/exiting
  // fullscreen can leave a stale scrollTop that shifts the entire layout
  useEffect(() => {
    document.querySelector(".app-shell-root")?.scrollTo(0, 0);
  }, [theaterMode]);

  useEffect(() => installOverlayRecovery(window, () => {
    captureHubEvent("ui_recovery", { reason: "orphaned_overlay_lock" });
  }), []);

  // Warm the lazy modal chunks once the browser is idle so a cold first open
  // never shows the null Suspense fallback.
  useEffect(() => {
    prefetchShellModals();
  }, []);

  const isDiscover = location.pathname.startsWith("/app/hub");
  const isProfile = location.pathname.startsWith("/app/profile") || location.pathname.startsWith("/app/users");
  const isSettings = location.pathname.startsWith("/app/settings");
  const isHubOrProfile = isDiscover || isProfile || isSettings;
  const isLibrary = location.pathname.startsWith("/app/library") || isCreatePagePicker;
  const isCommunity = location.pathname.startsWith("/app/community");
  const isMessages = location.pathname.startsWith("/app/messages");
  const isImmersiveBg = isHubOrProfile || isLibrary || isCommunity || isMessages;
  const isEditorBg = (location.pathname.match(/\/app\/worlds\/[^/]+\/edit/) || location.pathname.startsWith("/app/studio") || isAdminWorldInspect || (location.pathname === "/app/worlds/create" && !isPickerActive));
  const wallpaperPage: WallpaperPage = isMessages
    ? "messages"
    : isCommunity
      ? "community"
      : isLibrary
        ? "library"
        : isProfile
          ? "profile"
          : isSettings
            ? "settings"
            : "discover";
  const activeWallpaperPreset = useUserProfileStore((s) =>
    {
      const prefs = s.profile?.preferences ?? {};
      const legacyImmersive = normalizeWallpaperChoice(prefs.immersiveWallpaper, "starry-night");

      if (wallpaperPage === "messages") {
        return normalizeWallpaperChoice(prefs.messagesWallpaper ?? prefs.discoverWallpaper, "starry-night");
      }
      if (wallpaperPage === "community") {
        return normalizeWallpaperChoice(prefs.libraryWallpaper, "library-canvas");
      }
      if (wallpaperPage === "library") {
        return normalizeWallpaperChoice(prefs.libraryWallpaper, "library-canvas");
      }
      if (wallpaperPage === "profile") {
        return normalizeWallpaperChoice(prefs.profileWallpaper, legacyImmersive);
      }
      if (wallpaperPage === "settings") {
        return normalizeWallpaperChoice(prefs.settingsWallpaper, legacyImmersive);
      }
      return normalizeWallpaperChoice(prefs.discoverWallpaper, legacyImmersive);
    }
  );
  const bgImageSrc = getWallpaperSrc(activeWallpaperPreset);
  const wallpaperOpacityScale = useUserProfileStore((s) =>
    getWallpaperOpacityScale(s.profile?.preferences?.wallpaperOpacity)
  );
  const wallpaperGradientScale = useUserProfileStore((s) =>
    getWallpaperOpacityScale(s.profile?.preferences?.wallpaperGradientStrength)
  );
  const cloudyGlassStrength = useUserProfileStore((s) =>
    getVisualStrength(s.profile?.preferences?.cloudyGlassStrength)
  );
  const profileId = useUserProfileStore((s) => s.profile?.id ?? null);
  const fetchProfile = useUserProfileStore((s) => s.fetchProfile);
  const clearUserProfile = useUserProfileStore((s) => s.clear);
  const fetchExtensionInstallState = useExtensionsStore((s) => s.fetchInstallState);
  const { data: session, isPending: sessionPending } = useSession();
  const sessionUserId = session?.user?.id ?? null;
  useBrowseEngagement(sessionUserId, location.pathname);
  useSyncLanguage();
  // Referral auto-redeem, achievement queue, hub tag seeding, favorites hydration.
  useHostedShellEffects(sessionUserId);

  // Hook PostHog identity to the loaded user profile: the first time we see
  // a user id, call identify() so subsequent events attach to the same
  // PostHog person. When the profile clears (logout, session expiry),
  // call reset() so the browser's distinct_id rotates and future events
  // don't leak into the previous user's profile. Tied to profile.id rather
  // than raw session so it survives session-refresh races.
  const userIdForAnalytics = useUserProfileStore((s) => s.profile?.id ?? null);
  const userNameForAnalytics = useUserProfileStore((s) => s.profile?.username ?? null);
  const userLanguageForAnalytics = useUserProfileStore((s) => (s.profile?.preferences?.language as string) ?? null);
  const userRoleForAnalytics = useUserProfileStore((s) => s.profile?.role ?? null);
  const userCreatedAtForAnalytics = useUserProfileStore((s) => s.profile?.createdAt ?? null);
  const identifiedAnalyticsUser = useRef<string | null>(null);
  useEffect(() => {
    if (userIdForAnalytics) {
      identifiedAnalyticsUser.current = userIdForAnalytics;
      identifyAnalyticsUser(userIdForAnalytics, {
        username: userNameForAnalytics,
        language: userLanguageForAnalytics,
        role: userRoleForAnalytics,
      });
      // Ad-conversion attribution: a profile whose account was created within
      // the last 30 minutes is this session's signup (covers OAuth flows,
      // which have no client-side success callback). Fires after identify()
      // so the event lands on the identified person. Deduped inside.
      maybeTrackSignupFromCreatedAt(userCreatedAtForAnalytics, userIdForAnalytics);
      // Reddit pixel: mark this device as an existing user (24h dedupe
      // inside) so ad campaigns can exclude people who already use the app.
      trackActiveUserPixel();
    } else if (identifiedAnalyticsUser.current && !sessionPending && !sessionUserId) {
      resetAnalyticsUser();
      identifiedAnalyticsUser.current = null;
    }
  }, [userIdForAnalytics, userNameForAnalytics, userLanguageForAnalytics, userRoleForAnalytics, userCreatedAtForAnalytics, sessionPending, sessionUserId]);

  // Cross-device AI config sync. When a user id appears (or changes), pull the
  // server-side aiConfig blob into the local Zustand store. The store handles
  // pushing edits back via debounced PUT, so we only need to seed reads here.
  // Flush any pending debounced push on tab close so the last edit isn't lost.
  useEffect(() => {
    if (!userIdForAnalytics) return;
    useConfigStore.getState().syncFromServer();
    // beforeunload never fires on mobile Safari/Android when the tab is
    // swapped out, and pagehide is the only reliable "this page is going
    // away" signal there. The push itself is keepalive, so it survives.
    const flush = () => {
      void useConfigStore.getState().flushPendingPush();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [userIdForAnalytics]);

  const mobilePageScrollId = getMobileReadingPageId(location.pathname, location.search);
  useLayoutEffect(() => installMobileViewport(window, (recovery) => {
    captureHubEvent("ui_recovery", recovery);
  }, mobilePageScrollId, isMessages), [mobilePageScrollId, isMessages]);

  // ── Font size scaling ──
  const fontSize = useUiStore((s) => s.fontSize ?? "default");
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--font-size-scale",
      String(FONT_SIZE_SCALE[fontSize] ?? 1),
    );
  }, [fontSize]);

  const bgRef = useRef<HTMLDivElement>(null);

  // ── Crossfade state for smooth wallpaper transitions ──
  const targetOpacity = getScaledWallpaperOpacity(
    getWallpaperBaseOpacity(wallpaperPage),
    wallpaperOpacityScale,
  );
  const targetGradient = getGradientOverlay(wallpaperGradientScale);

  useLayoutEffect(() => {
    if (!mobilePageScrollId && !isMessages) return;
    return installReadingPageCanvas(document, {
      imageUrl: bgImageSrc,
      opacity: targetOpacity,
      gradient: targetGradient,
    });
  }, [mobilePageScrollId, isMessages, bgImageSrc, targetOpacity, targetGradient]);

  // Track previous wallpaper src for crossfade
  const [displayedSrc, setDisplayedSrc] = useState(bgImageSrc);
  const [prevSrc, setPrevSrc] = useState<string | null>(null);
  const [crossfading, setCrossfading] = useState(false);

  useEffect(() => {
    if (bgImageSrc !== displayedSrc) {
      // Start crossfade: show old image fading out, new image fading in
      setPrevSrc(displayedSrc);
      setDisplayedSrc(bgImageSrc);
      setCrossfading(true);
      const timer = setTimeout(() => {
        setCrossfading(false);
        setPrevSrc(null);
      }, 500); // Match transition duration
      return () => clearTimeout(timer);
    }
  }, [bgImageSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed extension install-state on login so the chat gate (and profile section)
  // resolve before they mount. Cheap single call; refreshed on each sign-in.
  useEffect(() => {
    if (sessionUserId) void fetchExtensionInstallState();
  }, [sessionUserId, fetchExtensionInstallState]);

  useEffect(() => {
    if (sessionPending) return;

    if (!sessionUserId) {
      // useSession() can briefly return null during a re-fetch (mobile tab
      // resume, network blip, BFCache thaw). Clearing the cached profile
      // synchronously made the topbar flicker from avatar → "Login" → avatar.
      // Real sign-outs go through signOut(), which clears the profile up
      // front, so the only thing that reaches this branch is either a fresh
      // unauthenticated load (profile already null, no-op) or a transient
      // null. Defer the clear so the latter has time to recover.
      const timer = setTimeout(() => {
        clearUserProfile();
      }, 5000);
      return () => clearTimeout(timer);
    }

    if (profileId !== sessionUserId) {
      void fetchProfile();
    }
  }, [sessionPending, sessionUserId, profileId, fetchProfile, clearUserProfile]);

  const hideSidebar = isAdminPage || (theaterMode && isPlayPage);
  const desktopSidebarOffset = getDesktopSidebarOffset(
    location.pathname,
    hideSidebar,
  );

  const shellSafeBottom = "max(0px, calc(var(--mobile-safe-bottom) - var(--keyboard-inset, 0px)))";
  const appShellContentStyle = {
    "--desktop-sidebar-offset": desktopSidebarOffset,
    "--mobile-bottom-offset": "0px",
    // iOS standalone PWA (viewport-fit=cover) extends content edge-to-edge, so
    // page chrome (hub control bar, feeds, bottom buttons) renders UNDER the
    // home indicator and gets visually cut off. Reserve the bottom safe-area
    // inset here so all chrome sits above it. env() is 0 on desktop/non-notch
    // devices, so this is a no-op there. Play/fullscreen pages are excluded —
    // the game canvas stays edge-to-edge and handles its own safe area (the
    // composer already pads with --mobile-safe-bottom). Once the keyboard
    // occludes the home indicator, it needs no additional safe-area gap.
    paddingBottom: isPlayPage ? undefined : isMessages ? `min(12px, ${shellSafeBottom})` : shellSafeBottom,
  } as CSSProperties;
  const cloudyGlassScale = cloudyGlassStrength / 100;
  const appShellRootStyle = {
    "--cloudy-surface-alpha": `${(0.4 + cloudyGlassScale * 0.18).toFixed(3)}`,
    "--cloudy-surface-soft-alpha": `${(0.34 + cloudyGlassScale * 0.16).toFixed(3)}`,
    "--cloudy-surface-strong-alpha": `${(0.46 + cloudyGlassScale * 0.2).toFixed(3)}`,
    "--cloudy-surface-border-alpha": `${(0.078 + cloudyGlassScale * 0.02).toFixed(3)}`,
    "--cloudy-surface-soft-border-alpha": `${(0.068 + cloudyGlassScale * 0.018).toFixed(3)}`,
    "--cloudy-surface-strong-border-alpha": `${(0.092 + cloudyGlassScale * 0.024).toFixed(3)}`,
    "--cloudy-surface-highlight-alpha": `${(0.092 + cloudyGlassScale * 0.038).toFixed(3)}`,
    "--cloudy-surface-soft-highlight-alpha": `${(0.074 + cloudyGlassScale * 0.032).toFixed(3)}`,
    "--cloudy-surface-strong-highlight-alpha": `${(0.11 + cloudyGlassScale * 0.042).toFixed(3)}`,
    "--cloudy-surface-shadow-alpha": `${(0.19 + cloudyGlassScale * 0.04).toFixed(3)}`,
    "--cloudy-surface-soft-shadow-alpha": `${(0.17 + cloudyGlassScale * 0.035).toFixed(3)}`,
    "--cloudy-surface-strong-shadow-alpha": `${(0.205 + cloudyGlassScale * 0.045).toFixed(3)}`,
    "--cloudy-surface-blur": `${Math.round(14 + cloudyGlassScale * 10)}px`,
    "--cloudy-surface-soft-blur": `${Math.round(12 + cloudyGlassScale * 8)}px`,
    "--cloudy-surface-strong-blur": `${Math.round(18 + cloudyGlassScale * 12)}px`,
    "--cloudy-input-alpha": `${(0.88 + cloudyGlassScale * 0.05).toFixed(3)}`,
  } as CSSProperties;

  return (
    <div
      className="app-shell-root relative overflow-hidden bg-background"
      data-clouded-glass-texture="cloudy"
      style={appShellRootStyle}
    >
      {/* ── Wallpaper layer (crossfade between pages) ──
           Only render the expensive mix-blend-screen + filter images when the
           wallpaper is actually visible. On play/editor pages these were hidden
           via opacity:0 but still consuming GPU for blend-mode compositing. */}
      {isImmersiveBg && (
        <div
          ref={bgRef}
          data-immersive-bg
          className="pointer-events-none absolute inset-0 z-0 transition-opacity duration-500 ease-in-out opacity-100"
        >
          <div className="absolute inset-0 bg-[#0B0A10]" />

          {/* Previous wallpaper (fading out during crossfade) */}
          {crossfading && prevSrc && (
            <img
              src={prevSrc}
              alt=""
              className="absolute inset-0 h-full w-full object-cover mix-blend-screen brightness-90 contrast-110 transition-opacity duration-500 ease-in-out"
              style={{ opacity: 0 }}
              decoding="async"
              width={1920}
              height={1080}
            />
          )}

          {/* Current wallpaper */}
          <img
            src={displayedSrc}
            alt="Wallpaper"
            className="absolute inset-0 h-full w-full object-cover mix-blend-screen brightness-90 contrast-110 transition-opacity duration-500 ease-in-out"
            style={{ opacity: targetOpacity }}
            decoding="async"
            width={1920}
            height={1080}
          />

          {/* Gradient overlay — transition via CSS */}
          <div
            className="absolute inset-0 transition-[background] duration-500 ease-in-out"
            style={{ background: targetGradient }}
          />
        </div>
      )}

      {/* ── Atmosphere layer (purple ambient glow) ──
           Only rendered when visible — the 140-180px blur blobs with will-change-transform
           were keeping 3 large GPU compositing layers resident even at opacity:0 on play pages. */}
      {!isAdminPage && !isImmersiveBg && !isEditorBg && atmosphereClass !== "atmosphere-none" && (
        <div
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden transition-opacity duration-500 ease-in-out"
          style={{
            opacity: atmosphereClass === "atmosphere-vibrant" ? 1 : atmosphereClass === "atmosphere-subtle" ? 0.25 : 0,
          }}
        >
          <div className="absolute -left-[30%] -top-[20%] h-[900px] w-[1100px] rounded-full bg-[#8B70E0]/[0.18] blur-[180px]" />
          <div className="absolute -right-[25%] -bottom-[15%] h-[800px] w-[1000px] rounded-full bg-[#8B70E0]/[0.14] blur-[160px]" />
          <div className="absolute left-[30%] -top-[30%] h-[700px] w-[800px] rounded-full bg-[#947AE4]/[0.10] blur-[140px]" />
        </div>
      )}

      {!hideSidebar && <Sidebar />}

      <div
        className={`app-shell-content relative z-10 flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden ${hideSidebar ? "" : "transition-[padding-left] duration-200 ease-out"}`}
        style={appShellContentStyle}
      >
        {!isAdminPage && <TopBar />}
        <main
          data-scroll-restoration-id="app-shell-main"
          className={`app-shell-main min-h-0 w-full min-w-0 flex-1 overflow-hidden ${enableMobilePageScroll ? "app-shell-main-mobile-scrollable" : ""}`}
        >
          <PersistentChat />
          {children}
        </main>
      </div>
      <PlaySessionPickerHost />
      <HostedShellOverlays />
      <Toaster />
      <BlockedDialogHost />
      {/* Modals are lazy chunks (prefetched on idle): closed = render null, so
          a null Suspense fallback is invisible even on a cold first open.
          WorldPreviewModal is mounted globally so the "Overview" button in the
          play session header (and any route outside /app/hub) can open it —
          the zustand store drives visibility, so a single mount is enough. */}
      <Suspense fallback={null}>
        <SessionManagerModal />
        <AuthModal />
        <HostedShellModals />
        <ExtensionPreviewModal />
      </Suspense>
    </div>
  );
}
