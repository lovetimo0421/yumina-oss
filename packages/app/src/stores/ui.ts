import { create } from "zustand";
import { persist } from "zustand/middleware";

export type FontSize = "small" | "default" | "large" | "x-large";

/** Root font-size multiplier per setting. Single source for the host document
 *  (app-shell writes it to --font-size-scale) AND the play sandbox (the
 *  WorldRenderer mirrors it across the bridge — CSS vars can't cross an
 *  iframe, which is why the setting never reached in-play chat text). */
export const FONT_SIZE_SCALE: Record<FontSize, number> = {
  small: 0.875,
  default: 1,
  large: 1.125,
  "x-large": 1.25,
};

/** Which keystroke sends a message composer. "enter" = Enter sends / Shift+Enter
 *  newline (Meta default); "mod-enter" = Ctrl/⌘+Enter sends / Enter newline (WeChat). */
export type ComposerSendKey = "enter" | "mod-enter";

export type ContentLevel = "safe" | "sensitive";

// Persisted guest preferences may still hold the legacy "r18" string from
// before the rename to "Limitless". Rewrite it on read so the rest
// of the app only ever sees the canonical value.
function normalizeStoredContentLevel(raw: unknown): ContentLevel {
  return raw === "sensitive" || raw === "r18" ? "sensitive" : "safe";
}

interface UiState {
  playZoomPercent: number;
  fontSize: FontSize;
  composerSendKey: ComposerSendKey;
  mobileNavOpen: boolean;
  theaterMode: boolean;
  recentPlayedWorlds: RecentPlayedWorld[];
  invitePanelDismissed: boolean;
  /** Community-event promo popups the user has dismissed, keyed by event id.
   *  Per-browser (localStorage) — a different browser/device shows it again.
   *  Keyed by event id so a brand-new campaign can surface its own popup. */
  dismissedEventPromos: string[];
  sessionManagerOpen: boolean;
  /** In-play persona manager overlay. Opened from the composer "+" menu (the
   *  call is routed sandbox → world-renderer → this store). Transient — excluded
   *  from persistence so it never auto-reopens on reload. */
  personaManagerOpen: boolean;
  /** In-play "share this playthrough" overlay. Opened from the composer "+"
   *  menu (sandbox → world-renderer → this store). Transient — not persisted. */
  sharePlaythroughOpen: boolean;
  /** In-play "support the creator" overlay. Opened by a card calling
   *  api.openSupport() (sandbox → world-renderer → this store), so a card can
   *  put a tip entry in its own UI instead of relying on the play header —
   *  which fullscreen custom-UI cards cover up. Transient — not persisted. */
  tipModalOpen: boolean;
  guestContentLevel: ContentLevel;
  guestBlurSensitive: boolean;
  setPlayZoomPercent: (percent: number) => void;
  adjustPlayZoomPercent: (delta: number) => void;
  resetPlayZoomPercent: () => void;
  setFontSize: (size: FontSize) => void;
  setComposerSendKey: (key: ComposerSendKey) => void;
  openMobileNav: () => void;
  closeMobileNav: () => void;
  toggleMobileNav: () => void;
  toggleTheaterMode: () => void;
  recordRecentPlayedWorld: (world: RecentPlayedWorldInput) => void;
  removeRecentPlayedWorld: (worldId: string) => void;
  dismissInvitePanel: () => void;
  dismissEventPromo: (eventId: string) => void;
  openSessionManager: () => void;
  closeSessionManager: () => void;
  openPersonaManager: () => void;
  closePersonaManager: () => void;
  openSharePlaythrough: () => void;
  closeSharePlaythrough: () => void;
  openTipModal: () => void;
  closeTipModal: () => void;
  setGuestContentLevel: (level: ContentLevel) => void;
  setGuestBlurSensitive: (blur: boolean) => void;
}

export interface RecentPlayedWorld {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  playedAt: string;
}

export interface RecentPlayedWorldInput {
  id: string;
  name: string;
  thumbnailUrl?: string | null;
}

const MIN_PLAY_ZOOM = 20;
const MAX_PLAY_ZOOM = 200;
const DEFAULT_PLAY_ZOOM = 80;
const MAX_RECENT_PLAYED_WORLDS = 5;

function clampPlayZoom(percent: number) {
  return Math.min(MAX_PLAY_ZOOM, Math.max(MIN_PLAY_ZOOM, Math.round(percent)));
}

function normalizeRecentPlayedWorld(world: RecentPlayedWorldInput): RecentPlayedWorld {
  return {
    id: world.id,
    name: world.name,
    thumbnailUrl: world.thumbnailUrl ?? null,
    playedAt: new Date().toISOString(),
  };
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      playZoomPercent: DEFAULT_PLAY_ZOOM,
      fontSize: "default" as FontSize,
      composerSendKey: "enter" as ComposerSendKey,
      mobileNavOpen: false,
      theaterMode: false,
      recentPlayedWorlds: [],
      invitePanelDismissed: false,
      dismissedEventPromos: [],
      sessionManagerOpen: false,
      personaManagerOpen: false,
      sharePlaythroughOpen: false,
      tipModalOpen: false,
      guestContentLevel: "safe" satisfies ContentLevel as ContentLevel,
      guestBlurSensitive: true,
      setPlayZoomPercent: (percent) => set({ playZoomPercent: clampPlayZoom(percent) }),
      adjustPlayZoomPercent: (delta) =>
        set((s) => ({ playZoomPercent: clampPlayZoom(s.playZoomPercent + delta) })),
      resetPlayZoomPercent: () => set({ playZoomPercent: DEFAULT_PLAY_ZOOM }),
      setFontSize: (size) => set({ fontSize: size }),
      setComposerSendKey: (key) => set({ composerSendKey: key }),
      openMobileNav: () => set({ mobileNavOpen: true }),
      closeMobileNav: () => set({ mobileNavOpen: false }),
      toggleMobileNav: () => set((s) => ({ mobileNavOpen: !s.mobileNavOpen })),
      toggleTheaterMode: () => set((s) => ({ theaterMode: !s.theaterMode })),
      dismissInvitePanel: () => set({ invitePanelDismissed: true }),
      dismissEventPromo: (eventId) =>
        set((s) =>
          s.dismissedEventPromos.includes(eventId)
            ? s
            : { dismissedEventPromos: [...s.dismissedEventPromos, eventId] }
        ),
      openSessionManager: () => set({ sessionManagerOpen: true }),
      closeSessionManager: () => set({ sessionManagerOpen: false }),
      openPersonaManager: () => set({ personaManagerOpen: true }),
      closePersonaManager: () => set({ personaManagerOpen: false }),
      openSharePlaythrough: () => set({ sharePlaythroughOpen: true }),
      closeSharePlaythrough: () => set({ sharePlaythroughOpen: false }),
      openTipModal: () => set({ tipModalOpen: true }),
      closeTipModal: () => set({ tipModalOpen: false }),
      setGuestContentLevel: (level) => set({ guestContentLevel: level }),
      setGuestBlurSensitive: (blur) => set({ guestBlurSensitive: blur }),
      recordRecentPlayedWorld: (world) =>
        set((s) => {
          const normalized = normalizeRecentPlayedWorld(world);
          const deduped = s.recentPlayedWorlds.filter((item) => item.id !== normalized.id);
          return {
            recentPlayedWorlds: [normalized, ...deduped].slice(0, MAX_RECENT_PLAYED_WORLDS),
          };
        }),
      removeRecentPlayedWorld: (worldId) =>
        set((s) => ({
          recentPlayedWorlds: s.recentPlayedWorlds.filter((item) => item.id !== worldId),
        })),
    }),
    {
      name: "yumina-ui",
      // Don't persist the transient persona-manager overlay flag, or it would
      // auto-reopen on the next page load.
      partialize: ({ personaManagerOpen: _omit, sharePlaythroughOpen: _omit2, tipModalOpen: _omit3, ...rest }) => rest,
      // Migrate the legacy "r18" guestContentLevel value (persisted before the
      // sensitive-content rename) so old browser caches don't keep round-tripping it.
      // Also drop the retired sidebar-collapse keys so old persisted state can't
      // reintroduce them.
      merge: (persistedState, currentState) => {
        if (!persistedState || typeof persistedState !== "object") return currentState;
        const {
          sidebarCollapsed: _legacySidebarCollapsed,
          hasSeenCollapseHint: _legacyHasSeenCollapseHint,
          ...persisted
        } = persistedState as Partial<UiState> & {
          guestContentLevel?: unknown;
          sidebarCollapsed?: unknown;
          hasSeenCollapseHint?: unknown;
        };
        return {
          ...currentState,
          ...persisted,
          guestContentLevel: normalizeStoredContentLevel(persisted.guestContentLevel),
        };
      },
    },
  )
);
