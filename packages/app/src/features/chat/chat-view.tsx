import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { StateGuardHost, StateGuardHostButton } from "./state-guard-host";
import { guardLabels } from "../../../sandbox/extensions/state-update-guard/details";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, Maximize, Minimize } from "lucide-react";
import { useChatStore } from "@/stores/chat";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";
import { useExtensionsStore } from "@/stores/extensions";
import { EXTENSION_REGISTRY, SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { useAudioStore } from "@/stores/audio";
import { stripDirectivesForSandbox } from "@/lib/strip-directives";
import { GameFrame } from "./game-frame";
import { SessionHeader } from "./session-header";
import { type YuminaAPI } from "@/features/studio/lib/custom-component-renderer";
import { safeParseWorldDef } from "@/lib/utils";
import { absoluteImageUrl } from "@/lib/asset-url";
import { expandMacros } from "@yumina/engine";
import { resolveDisplayMacros } from "@/lib/resolve-display-macros";
import { TOP_EDGE_ALWAYS_PX, TOP_EDGE_PX } from "@/lib/top-edge-gate";
import { useUiStore } from "@/stores/ui";
import { useUserProfileStore } from "@/stores/user-profile";
import { useImmersiveMode } from "@/hooks/use-fullscreen";
import { isIOS, useTouchDevice } from "@/hooks/use-touch-device";
import { usePlaytimeTracker } from "./use-playtime-tracker";
import { CombatPanel } from "./combat-panel";
import { WorldRenderer } from "./world-renderer";
import { PersonaManagerDialog } from "./persona-manager-dialog";
import { SharePlaythroughModal } from "./share-playthrough-modal";
import { TipModal } from "@/edition/slots";
import { fetchCreditsForChat } from "@/edition/slots.state";
import { useFeature } from "@/edition/edition";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ModelBrowser } from "./model-browser";
import {
  FullscreenFloatingControls,
  shouldPauseFloatingBarAutoHide,
} from "./fullscreen-floating-controls";
import { useModelsStore } from "@/stores/models";
import {
  DISPLAY_MODE_CONFIRM_TIMEOUT_MS,
  getDisplayModeConfirmationStep,
  getDisplayModeSecondsRemaining,
} from "./display-mode-confirmation";
import { navigateToStoryReturn, type StoryReturnContext } from "@/lib/story-return";
import { navigateBackSafely } from "@/lib/safe-back";
import { makeVariableKeyResolver } from "./variable-key";
import {
  getMobileExitActivation,
  getImmersiveExitLayout,
  scheduleMobileExitAutoCollapse,
} from "./immersive-exit-layout";

const apiBase = import.meta.env.VITE_API_URL || "";

interface ChatViewProps {
  sessionId: string;
  /** When false the view is hidden (display:none) but kept mounted to preserve the sandbox iframe. */
  isActive?: boolean;
  moderationGroupKey?: string;
  returnContext?: StoryReturnContext;
}

export function ChatView({
  sessionId,
  isActive = true,
  moderationGroupKey,
  returnContext = {},
}: ChatViewProps) {
  const { t, i18n } = useTranslation("chat");
  const session = useChatStore(s => s.session);
  const messages = useChatStore(s => s.messages);
  const gameState = useChatStore(s => s.gameState);
  const readOnly = useChatStore(s => s.readOnly);
  const isStreaming = useChatStore(s => s.isStreaming);
  const streamingContent = useChatStore(s => s.streamingContent);
  const streamingBg = useChatStore(s => s.streamingBg);
  const error = useChatStore(s => s.error);
  const clearError = useChatStore(s => s.clearError);
  const loadSession = useChatStore(s => s.loadSession);
  const router = useRouter();
  const playZoomPercent = useUiStore((s) => s.playZoomPercent);
  const theaterMode = useUiStore((s) => s.theaterMode);
  const isTouch = useTouchDevice();
  const mobileAutoSystemFullscreen = useUserProfileStore(
    (s) => s.profile?.preferences?.mobileAutoSystemFullscreen === true,
  );
  // Unified auto-fullscreen preference — absent means on, so existing users
  // keep the current auto-enter behavior without a backfill.
  const autoFullscreenOnPlay = useUserProfileStore(
    (s) => s.profile?.preferences?.autoFullscreenOnPlay !== false,
  );
  // Signed-in player who never explicitly chose → ask once on first custom-UI
  // world entry instead of auto-entering. Anon (no profile) keeps the default
  // auto behavior since there is no account to save the answer to.
  const autoFullscreenPrefUnset = useUserProfileStore(
    (s) => s.profile != null && s.profile.preferences?.autoFullscreenOnPlay === undefined,
  );
  const combatActive = gameState.combat_active === true;
  const navigateBackFromPlay = useCallback(() => {
    if (moderationGroupKey) {
      navigateBackSafely(
        router.history,
        `/app/admin/moderation/${encodeURIComponent(moderationGroupKey)}`,
      );
      return;
    }
    navigateToStoryReturn(router.history, returnContext);
  }, [moderationGroupKey, returnContext, router.history]);

  usePlaytimeTracker(sessionId, isActive);
  const { open: rawOutputOpen, setOpen: setRawOutputOpen } = useRawOutputTrigger(isActive);
  // The composer "+" → "人设" item (inside the sandbox iframe) calls
  // api.openPersonaManager → world-renderer routes it to this store flag, which
  // this view renders as <PersonaManagerDialog>. Routing through the store (not
  // a window hook) keeps a single source of truth and avoids mount-timing races.
  const personaManagerOpen = useUiStore((s) => s.personaManagerOpen);
  const closePersonaManager = useUiStore((s) => s.closePersonaManager);
  const sharePlaythroughOpen = useUiStore((s) => s.sharePlaythroughOpen);
  const closeSharePlaythrough = useUiStore((s) => s.closeSharePlaythrough);
  // api.openSupport() → same store route → <TipModal>. Mounted here rather than
  // in SessionHeader because a fullscreen custom-UI card hides the header
  // entirely, which is the whole reason a card would ask for this dialog.
  const tipModalOpen = useUiStore((s) => s.tipModalOpen);
  const closeTipModal = useUiStore((s) => s.closeTipModal);
  const tipCreatorId = session?.world?.creatorId;
  const tipViewerId = session?.currentUser?.id;

  // Track which session we last reset scroll for, to avoid re-firing on reactivation
  const lastScrollResetRef = useRef<string>("");
  useLayoutEffect(() => {
    if (!isActive) return;
    if (lastScrollResetRef.current === sessionId) return;
    lastScrollResetRef.current = sessionId;
    // Prevent inheriting stale viewport offset when entering chat from scroll-heavy routes.
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    // Reset app-shell-root scroll — fullscreen iframe requires zero offset
    document.querySelector(".app-shell-root")?.scrollTo(0, 0);
  }, [sessionId, isActive]);

  useEffect(() => {
    // Stop audio when hidden (navigated away) or switching sessions
    if (!isActive) {
      useAudioStore.getState().cleanup();
    }
    // Also clean up on unmount or sessionId change
    return () => {
      useAudioStore.getState().cleanup();
    };
  }, [sessionId, isActive]);

  useEffect(() => {
    const store = useChatStore.getState();
    const hasLoadedSession = store.session?.id === sessionId;
    const isDifferentSession = store.session?.id !== sessionId;

    // Only tear down UI state when switching to a *different* session.
    // When returning to the same session (e.g. navigating back from library),
    // keep existing data so the sandbox iframe isn't destroyed & assets don't reload.
    if (isDifferentSession) {
      store.stopGeneration();
      store.setSession(null);
      store.setMessages([]);
      store.setGameState({});
      store.clearPendingChoices();
      store.clearError();
    }
    if (!hasLoadedSession) {
      store.loadSession(sessionId);
    }
  }, [sessionId]);

  // Re-fetch world schema when tab/window regains focus (e.g., user edited
  // in studio then switched back to the game tab). This ensures the game
  // always renders the latest messageRenderer, components, and settings.
  // Also refresh when isActive transitions true (returning from library).
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    // Refresh session when reactivated (user navigated back from library/hub)
    if (isActive && !prevActiveRef.current && session?.id === sessionId) {
      useChatStore.getState().loadSession(sessionId);
    }
    prevActiveRef.current = isActive;
  }, [isActive, session?.id, sessionId]);

  useEffect(() => {
    if (!isActive) return;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const handleVisibility = () => {
      clearTimeout(debounceTimer);
      if (document.visibilityState !== "visible" || session?.id !== sessionId) return;
      if (useChatStore.getState().isStreaming) return;
      clearTimeout(debounceTimer);
      // Light sync on wake/tab return — full loadSession reloads audio/assets and
      // feels sluggish on mobile. Returning from library still uses loadSession above.
      debounceTimer = setTimeout(() => {
        const current = useChatStore.getState();
        if (document.visibilityState !== "visible" || current.session?.id !== sessionId || current.isStreaming) return;
        void current.refreshMessages({ preserveHistory: true });
      }, 600);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearTimeout(debounceTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [sessionId, session?.id, isActive]);

  // Steam-style playtime heartbeat — pings server every 30s while tab is visible
  const worldDef = useMemo(
    () => safeParseWorldDef(session?.world?.schema),
    [session?.world?.schema],
  );
  const hasSessionMismatch = Boolean(session && session.id !== sessionId);

  // fullScreenMode was computed from v1 customUI[] surface:"app" presence.
  // v2's rootComponent always occupies the full viewport, so every v2 world
  // is effectively fullscreen. Keep the variable so the immersive-toggle
  // effects (keyboard shortcut, fullscreen API) still fire.
  const fullScreenMode = Boolean(worldDef?.rootComponent);
  const pendingChoices = useChatStore(s => s.pendingChoices);
  const streamingReasoning = useChatStore(s => s.streamingReasoning);
  const hasEarlierMessages = useChatStore(s => s.hasEarlierMessages);
  const isLoadingEarlier = useChatStore(s => s.isLoadingEarlier);
  const sendFailureNonce = useChatStore(s => s.sendFailureNonce);
  const selectedModel = useConfigStore(s => s.selectedModel);
  const mixMode = useConfigStore(s => s.mixMode);
  const modelPool = useConfigStore(s => s.modelPool);
  const userPlan = useCreditStore(s => s.plan) ?? "free";
  const preferredProvider = useCreditStore(s => s.provider);
  const billingEnabled = useFeature("billing");
  const extensionInstallState = useExtensionsStore(s => s.installState);
  const memorySummaryEnabled = extensionInstallState[SESSION_MEMORY_EXTENSION_KEY] === "installed";
  // clientEntry ids of installed extensions — drives the sandbox contribution
  // registry's lazy loading (uninstalled extension → chunk never fetched).
  const installedExtensions = useMemo(
    () =>
      EXTENSION_REGISTRY.filter((e) => e.clientEntry && extensionInstallState[e.key] === "installed").map(
        (e) => e.clientEntry as string,
      ),
    [extensionInstallState],
  );

  // Compute greeting for universal canvas (parent pushes to sandbox).
  //
  // Greeting expansion has to merge the server-pushed metadata with a client-side
  // fallback: on existing sessions created before persona was wired, metadata.personaName
  // may be absent — engine's {{user}} handler would then fall through to
  // world.settings.playerName ("User") instead of the Yumina account nickname,
  // producing literal "User" in greetings for users with no active persona.
  //
  // Regression history for this code path: 70df57db → 3f03f22d → [re-lost] → this fix.
  // The root issue is that expandMacros consumes the {{user}} token here, so the
  // downstream resolveDisplayMacros sticker can't repair it. We have to put the
  // right name into metadata BEFORE the first expansion pass.
  const greetingContent = useMemo(() => {
    if (!worldDef) return null;
    const entries = worldDef.entries ?? [];
    const greetingEntry = entries
      .filter((e) => e.role === "greeting" && e.enabled !== false)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
    const raw = greetingEntry?.content?.trim()
      || (worldDef.settings as { greeting?: string } | undefined)?.greeting?.trim()
      || null;
    if (!raw) return null;
    const serverMetadata = (session as any)?.state?.metadata ?? {};
    const metadata = { ...serverMetadata };
    // Fallback chain must match displayUserName: persona → username → displayUsername
    // → name → playerName → "Player". expandMacros only knows personaName +
    // world.settings.playerName, so we pre-fill personaName with the best
    // account-identity value we have. Leaving it undefined would make the
    // engine fall through to playerName directly, which skips the username
    // layer users expect for {{user}}.
    if (!metadata.personaName) {
      const u = (session as any)?.currentUser as
        | { username?: string | null; displayUsername?: string | null; name?: string | null }
        | undefined;
      metadata.personaName =
        u?.username
        || u?.displayUsername
        || u?.name
        || undefined;
    }
    return expandMacros(raw, worldDef, {
      variables: gameState,
      turnCount: 0,
      metadata,
    } as any);
  }, [worldDef, gameState, session]);

  // Auto-enter immersive mode for fullscreen components, unless the user
  // opted out via the autoFullscreenOnPlay preference — then the card opens
  // in the normal layout and the manual fullscreen button still works.
  // On touch devices this defaults to theater mode only, so sleep/wake or
  // returning to play does not restore browser fullscreen into landscape.
  // AppShell's own effect handles exiting immersive when navigating away.
  const { toggle: toggleImmersive } = useImmersiveMode();
  const shouldAskAutoFullscreen =
    autoFullscreenPrefUnset && !readOnly && !moderationGroupKey;
  const [fullscreenAskOpen, setFullscreenAskOpen] = useState(false);
  const [fullscreenPendingChoice, setFullscreenPendingChoice] = useState<boolean | null>(null);
  const fullscreenPreviousModeRef = useRef(false);
  useEffect(() => {
    if (!fullScreenMode || !isActive || !shouldAskAutoFullscreen) return;
    setFullscreenAskOpen(true);
  }, [fullScreenMode, isActive, shouldAskAutoFullscreen]);

  const setDisplayMode = useCallback((enableFullscreen: boolean) => {
    if (useUiStore.getState().theaterMode === enableFullscreen) return;

    // Entering browser fullscreen must stay directly inside the user's click
    // handler because the Fullscreen API requires transient user activation.
    if (enableFullscreen && isTouch && !mobileAutoSystemFullscreen) {
      useUiStore.getState().toggleTheaterMode();
      return;
    }
    toggleImmersive();
  }, [isTouch, mobileAutoSystemFullscreen, toggleImmersive]);

  const previewAutoFullscreen = useCallback((enable: boolean) => {
    fullscreenPreviousModeRef.current = useUiStore.getState().theaterMode;
    setDisplayMode(enable);
    setFullscreenPendingChoice(enable);
  }, [setDisplayMode]);

  const restoreAutoFullscreenPreview = useCallback((keepDialogOpen: boolean) => {
    setDisplayMode(fullscreenPreviousModeRef.current);
    setFullscreenPendingChoice(null);
    if (!keepDialogOpen) setFullscreenAskOpen(false);
  }, [setDisplayMode]);
  const revertAutoFullscreenPreview = useCallback(() => {
    restoreAutoFullscreenPreview(true);
  }, [restoreAutoFullscreenPreview]);
  const cancelAutoFullscreenPreview = useCallback(() => {
    restoreAutoFullscreenPreview(false);
  }, [restoreAutoFullscreenPreview]);

  const confirmAutoFullscreen = useCallback(() => {
    if (fullscreenPendingChoice === null) return;
    const enable = fullscreenPendingChoice;
    setFullscreenPendingChoice(null);
    setFullscreenAskOpen(false);
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/users/me`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ preferences: { autoFullscreenOnPlay: enable } }),
        });
        if (res.ok) await useUserProfileStore.getState().forceFetchProfile();
      } catch {
        // Save failed — the pref stays unset and the ask returns next entry.
      }
    })();
  }, [fullscreenPendingChoice]);

  useEffect(() => {
    if (!fullScreenMode || !isActive) return;
    if (autoFullscreenOnPlay && !shouldAskAutoFullscreen && !useUiStore.getState().theaterMode) {
      if (!isTouch || mobileAutoSystemFullscreen) {
        toggleImmersive();
      } else {
        useUiStore.getState().toggleTheaterMode();
      }
    }
    (window as any).__yuminaToggleImmersive = toggleImmersive;
    let hadSystemFullscreen = Boolean(document.fullscreenElement);
    const onFsChange = () => {
      const active = Boolean(document.fullscreenElement);
      if (active) {
        hadSystemFullscreen = true;
        return;
      }
      // Theater-only mode never enters browser fullscreen — ignore unrelated events.
      if (!hadSystemFullscreen || !useUiStore.getState().theaterMode) return;
      hadSystemFullscreen = false;
      useUiStore.getState().toggleTheaterMode();
      // The browser reserves Escape for leaving fullscreen. During a display
      // mode preview, that action rejects the preview and returns to selection.
      if (fullscreenPendingChoice === true) {
        setFullscreenPendingChoice(null);
        return;
      }
      // Leaving fullscreen reveals the floating bar, whose "Return to
      // fullscreen" button carries the F11 badge — no pill needed.
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      delete (window as any).__yuminaToggleImmersive;
    };
  }, [fullScreenMode, toggleImmersive, isActive, isTouch, mobileAutoSystemFullscreen, autoFullscreenOnPlay, shouldAskAutoFullscreen, fullscreenPendingChoice]);

  // ESC: first press exits immersive mode, second press navigates to library
  useEffect(() => {
    if (!fullScreenMode || !isActive) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The auto-fullscreen ask dialog handles its own ESC (dismiss); don't
        // also navigate away underneath it.
        if (fullscreenAskOpen) return;
        if (useUiStore.getState().theaterMode) {
          toggleImmersive();
        } else {
          navigateBackFromPlay();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [fullScreenMode, navigateBackFromPlay, toggleImmersive, isActive, fullscreenAskOpen]);

  // Leaving immersive mode must hand the player back some chrome. The floating
  // bar is the ONLY navigation on a play page — SessionHeader never renders for
  // rootComponent worlds, TopBar returns null here, and the mobile nav drawer is
  // suppressed — so a bar that mounts hidden strands the player with no way back
  // to the library and no way to re-enter fullscreen. Bumping this nonce on every
  // theater→windowed transition re-reveals it (then it auto-hides as usual).
  // Mount alone is not the trigger: the auto-enter-immersive path mounts the bar
  // for one frame on the way into theater mode, and that flash is what the
  // hidden-by-default change was meant to kill.
  const [barRevealNonce, setBarRevealNonce] = useState(0);
  const prevTheaterModeRef = useRef(theaterMode);
  useEffect(() => {
    if (prevTheaterModeRef.current && !theaterMode) {
      setBarRevealNonce((n) => n + 1);
    }
    prevTheaterModeRef.current = theaterMode;
  }, [theaterMode]);

  // Resolve {{user}} / {{char}} for display. Fallback chain:
  //   1. personaName from state.metadata (server-populated: active persona OR
  //      account username)
  //   2. currentUser.username (stable @handle — survives name changes)
  //   3. currentUser.displayUsername (case-preserved variant)
  //   4. currentUser.name (user-editable display name, last account fallback)
  //   5. worldDef.settings.playerName (creator default)
  //   6. "Player" (never literal "User" — see engine/macros.ts userHandler)
  const displayUserName = useMemo(() => {
    const meta = (session as any)?.state?.metadata;
    const u = (session as any)?.currentUser as
      | { username?: string | null; displayUsername?: string | null; name?: string | null }
      | undefined;
    return (meta?.personaName as string)
      || u?.username
      || u?.displayUsername
      || u?.name
      || (worldDef?.settings as any)?.playerName
      || "Player";
  }, [session, worldDef]);

  // Persona-aware user object pushed into the sandbox as `useYumina().user`.
  // Same branching as displayUserName for the name; avatar is persona.avatarUrl
  // when active else account image. Creators writing `<img src={user.avatar}/>`
  // in custom TSX get the correct identity without branching on persona state.
  const sandboxUser = useMemo(() => {
    const meta = (session as any)?.state?.metadata;
    const u = (session as any)?.currentUser as
      | { username?: string | null; displayUsername?: string | null; name?: string | null; image?: string | null }
      | undefined;
    const name = (meta?.personaName as string)
      || u?.username
      || u?.displayUsername
      || u?.name
      || (worldDef?.settings as any)?.playerName
      || "Player";
    // MUST be absolute: this value crosses into the sandbox iframe, where a raw
    // S3 key ("users/<id>/image/<file>.jpg") or a root-relative "/cdn/..." is
    // resolved against the SANDBOX document, not the app origin. The SPA
    // catch-all answers those with index.html (200 text/html), so <img> gets
    // markup where it wants bytes and fires onError — the player sees a broken
    // avatar. Only OAuth accounts (image = full https URL) ever worked, which
    // is why this survived: uploaded avatars are stored as bare S3 keys.
    // absoluteImageUrl is idempotent, so http(s) values pass through unchanged.
    const avatar =
      absoluteImageUrl((meta?.personaImage as string | undefined) || u?.image) ?? null;
    return { name, avatar };
  }, [session, worldDef]);

  const displayCharName = useMemo(() => {
    const charEntry = worldDef?.entries?.find((e: any) => e.role === "character" && e.enabled);
    return charEntry?.name ?? "Assistant";
  }, [worldDef]);

  // Resolve macros in message content before passing to sandbox
  const resolvedMessages = useMemo(() =>
    messages.map((m) => ({
      ...m,
      content: resolveDisplayMacros(m.content, displayUserName, displayCharName),
    })),
    [messages, displayUserName, displayCharName],
  );

  // `api.setVariable("hunger", …)` has to land on the variable's id, not create
  // a phantom key the next turn's normalizeState() throws away.
  const resolveVariableKey = useMemo(
    () => makeVariableKeyResolver(worldDef?.variables),
    [worldDef?.variables],
  );

  const yuminaAPI = useMemo<YuminaAPI>(
    () => ({
      sendMessage: (text: string, attachments?: import("@yumina/shared").ChatImageInput[]) => useChatStore.getState().sendMessage(text, undefined, attachments),
      setVariable: (id: string, value: number | string | boolean | Record<string, unknown> | unknown[]) =>
        useChatStore.getState().setVariableDirectly(resolveVariableKey(id), value),
      executeAction: (actionId: string) =>
        useChatStore.getState().executeActionRule(actionId),
      switchGreeting: (index: number) =>
        useChatStore.getState().switchGreeting(index),
      variables: gameState,
      globalVariables: gameState,
      worldName: worldDef?.name ?? "",
      worldCover: absoluteImageUrl(session?.world?.thumbnailUrl),
      // image resolved for the same sandbox-origin reason as user.avatar above —
      // the sandbox API docs hand creators `<img src={currentUser?.image} />` as
      // the account-only avatar recipe, so it has to be fetchable too.
      currentUser: session?.currentUser
        ? { ...session.currentUser, image: absoluteImageUrl(session.currentUser.image) }
        : (session?.userId ? { id: session.userId, name: "Player" } : null),
      messages: resolvedMessages as unknown as Array<Record<string, unknown>>,
      playAudio: (trackId, opts) => useAudioStore.getState().playTrack(trackId, opts),
      stopAudio: (trackId, fadeDuration) => {
        if (trackId) useAudioStore.getState().stopTrack(trackId, fadeDuration);
        else useAudioStore.getState().stopAll();
      },
      pauseAudio: (trackId) => useAudioStore.getState().pauseTrack(trackId),
      resumeAudio: (trackId) => useAudioStore.getState().resumeTrack(trackId),
      setAudioVolume: (type, volume) => {
        const s = useAudioStore.getState();
        if (type === "bgm") s.setBgmVolume(volume);
        else if (type === "sfx") s.setSfxVolume(volume);
        else s.setMasterVolume(volume);
      },
      getAudioVolume: (type) => {
        const s = useAudioStore.getState();
        if (type === "bgm") return s.bgmVolume;
        if (type === "sfx") return s.sfxVolume;
        return s.masterVolume;
      },
    }),
    [gameState, resolvedMessages, resolveVariableKey, worldDef?.name, session?.currentUser, session?.room, session?.userId, session?.world?.id, session?.world?.thumbnailUrl]
  );

  // Fullscreen components (like VN) handle streaming internally via
  // api.isStreaming + api.streamingContent. We do NOT merge streamingSegments
  // here because that would cause segKey to change on every new segment,
  // resetting the segment index and trapping the user at segment 0.
  // Only streamingBg is merged for immediate background transitions.
  const fullScreenVariables = useMemo(() => {
    if (isStreaming && streamingBg) {
      return { ...gameState, currentBg: streamingBg };
    }
    return gameState;
  }, [gameState, isStreaming, streamingBg]);

  const resolvedGreetingContent = useMemo(
    () => (greetingContent ? resolveDisplayMacros(greetingContent, displayUserName, displayCharName) : null),
    [greetingContent, displayUserName, displayCharName],
  );
  const fullScreenAPI = useMemo<YuminaAPI>(
    () => ({
      ...yuminaAPI,
      variables: fullScreenVariables,
      isStreaming,
      streamingContent: isStreaming ? stripDirectivesForSandbox(streamingContent ?? "") : "",
      // WorldRenderer reads these directly off api (legacy path passes them
      // via extraProps={canvasExtraProps} instead). Mirror them here so
      // rootComponent worlds get greetingContent / pendingChoices / etc.
      pendingChoices: pendingChoices ?? [],
      error: error ?? null,
      sendFailureNonce,
      streamingReasoning: streamingReasoning ?? "",
      readOnly,
      checkpoints: [],
      greetingContent: resolvedGreetingContent,
      selectedModel,
      mixMode,
      modelPool,
      userPlan,
      memorySummaryEnabled,
      installedExtensions,
      preferredProvider,
      hasEarlierMessages,
      isLoadingEarlier,
    } as YuminaAPI),
    [
      yuminaAPI, fullScreenVariables, isStreaming, streamingContent,
      pendingChoices, error, sendFailureNonce, streamingReasoning, readOnly,
      resolvedGreetingContent, selectedModel, mixMode, modelPool, userPlan, memorySummaryEnabled, installedExtensions, preferredProvider,
      hasEarlierMessages, isLoadingEarlier,
    ]
  );
  const playZoomStyle = useMemo(
    () =>
      ({
        "--play-ui-scale": `${playZoomPercent / 100}`,
      }) as CSSProperties,
    [playZoomPercent]
  );
  // Fetch credits/provider on mount (hosted only; a BYOK build has no wallet)
  useEffect(() => {
    if (billingEnabled) fetchCreditsForChat();
  }, [billingEnabled]);

  // Shared chat/UI state pushed into the sandbox. Both the universal canvas and
  // fullscreen `app` surfaces need this — fullscreen apps can embed <ChatCanvas />,
  // and its MessageInput/ModelTrigger read selectedModel/userPlan/preferredProvider
  // from sandbox state.
  const sharedChatExtraProps = useMemo(() => ({
    isStreaming,
    pendingChoices: pendingChoices ?? [],
    error: error ?? null,
    streamingReasoning: streamingReasoning ?? "",
    readOnly,
    checkpoints: [],
    greetingContent: greetingContent ? resolveDisplayMacros(greetingContent, displayUserName, displayCharName) : null,
    selectedModel,
    mixMode,
    modelPool,
    userPlan,
    memorySummaryEnabled,
    installedExtensions,
    preferredProvider,
  }), [isStreaming, pendingChoices, error, streamingReasoning, readOnly, greetingContent, displayUserName, displayCharName, selectedModel, mixMode, modelPool, userPlan, memorySummaryEnabled, installedExtensions, preferredProvider]);

  // sharedChatExtraProps is consumed through api/user channels into v2 WorldRenderer.
  void sharedChatExtraProps;

  if (error && !session) {
    return (
      <div className="flex h-full w-full min-w-0 flex-1 items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm">{error}</p>
          <button
            className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            onClick={() => {
              clearError();
              loadSession(sessionId);
            }}
          >
            {t("view.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!session || hasSessionMismatch) {
    return (
      <div className="flex h-full w-full min-w-0 flex-1 items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <p className="text-sm">{t("view.loadingSession")}</p>
        </div>
      </div>
    );
  }

  // Every world is v2 — migrateWorldDefinition guarantees rootComponent exists
  // for all loaded worlds. The v1 fullscreen/canvas/SandboxedRenderer render
  // paths were deleted in the v1→v2 unification (phase 5).
  // A GAME world: the schema names a first-party game page instead of a chat rootComponent
  // (worlds.schema.game.path, seeded by scripts/seed-pvz-world.mjs). Play means "open that page
  // as this player" -- the platform passes the account identity down so the game greets by name
  // ("ALEX FOUND", "WAITING FOR ALEX..."). Same-origin paths only: a world can never point this
  // frame off-platform, and the session it rides was created by the normal play flow, so history,
  // continue-playing and play counts all keep working.
  const gamePath = (session?.world?.schema as { game?: { path?: unknown } } | undefined)?.game?.path;
  if (typeof gamePath === "string" && gamePath.startsWith("/") && !gamePath.startsWith("//")) {
    // The language belongs to the CARD, not to the reader's menu setting. A game world ships as
    // one worlds row per language sharing one game.path, so opening the Japanese card has to hand
    // the game Japanese even when the player browses Yumina in English. Sourcing this from i18n
    // made every variant play identically, which is why the variants read as duplicate store
    // entries. UI language stays the fallback for a world that never declared one.
    const worldLanguage = (session?.world as { language?: unknown } | undefined)?.language;
    const gameLang = (typeof worldLanguage === "string" && worldLanguage)
      || i18n.resolvedLanguage || "en";
    const gameSrc = gamePath + (gamePath.includes("?") ? "&" : "?")
      + "name=" + encodeURIComponent(displayUserName)
      + "&lang=" + encodeURIComponent(gameLang);
    return (
      <div className="play-page-root relative flex h-full w-full min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        {!fullScreenMode && !theaterMode && (
          <SessionHeader showSidebarToggle={false} onBack={navigateBackFromPlay} />
        )}
        <GameFrame
          src={gameSrc}
          title={(session?.world as { name?: string } | undefined)?.name ?? "game"}
          worldId={(session?.world as { id?: string } | undefined)?.id}
        />
      </div>
    );
  }

  const rc = worldDef?.rootComponent;
  if (!rc) {
    // This should never happen post-migration — every DB world is v20 with
    // rootComponent, and the migrator synthesizes a default one for any world
    // that arrives without one. Surface as an explicit error rather than
    // silently rendering nothing.
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        World has no rootComponent. This indicates corrupted schema — contact support.
      </div>
    );
  }
  return (
    <div
      className="play-page-root relative flex h-full w-full min-w-0 min-h-0 flex-1 flex-col overflow-hidden"
      data-admin-review-preview={moderationGroupKey ? "true" : undefined}
      style={playZoomStyle}
    >
      {fullScreenMode && !theaterMode && (
        <FullscreenFloatingBar
          moderationGroupKey={moderationGroupKey}
          onBack={navigateBackFromPlay}
          revealNonce={barRevealNonce}
          memorySummaryEnabled={memorySummaryEnabled}
        />
      )}
      {theaterMode && <ImmersiveExitButton />}
      <StateGuardHost />
      {!fullScreenMode && <StateGuardHostButton />}
      {!fullScreenMode && !theaterMode && <SessionHeader showSidebarToggle={false} onBack={navigateBackFromPlay} />}
      <WorldRenderer
        entryFile={rc.entryFile}
        files={rc.files}
        precompiled={rc.compiled}
        variables={fullScreenVariables}
        variableDefs={worldDef?.variables ?? []}
        api={fullScreenAPI}
        sessionId={sessionId}
        worldId={session?.worldId ?? ""}
        user={sandboxUser}
        className="flex-1 min-h-0"
        isActive={isActive}
        entries={worldDef?.entries ?? []}
        loreUiBindings={worldDef?.loreUiBindings ?? []}
        worldbooks={worldDef?.worldbooks ?? []}
      />
      {combatActive && session?.id && <CombatPanel sessionId={session.id} />}
      <RawOutputDialog open={rawOutputOpen} onOpenChange={setRawOutputOpen} />
      <PersonaManagerDialog
        open={personaManagerOpen}
        onClose={closePersonaManager}
        sessionId={session?.id}
      />
      <SharePlaythroughModal
        open={sharePlaythroughOpen}
        worldId={session?.worldId ?? ""}
        sessionId={sessionId}
        defaultTitle={worldDef?.name ?? session?.world?.name ?? ""}
        onClose={closeSharePlaythrough}
      />
      {billingEnabled && tipCreatorId && tipViewerId && tipCreatorId !== tipViewerId && (
        <TipModal
          open={tipModalOpen}
          onClose={closeTipModal}
          worldId={session?.worldId ?? ""}
          worldName={worldDef?.name ?? session?.world?.name ?? ""}
          creatorId={tipCreatorId}
        />
      )}
      <AutoFullscreenAskDialog
        open={fullscreenAskOpen}
        onOpenChange={setFullscreenAskOpen}
        pendingChoice={fullscreenPendingChoice}
        onPreview={previewAutoFullscreen}
        onConfirm={confirmAutoFullscreen}
        onRevert={revertAutoFullscreenPreview}
        onCancel={cancelAutoFullscreenPreview}
      />
    </div>
  );
}

/**
 * One-time ask shown the first time a signed-in player opens a custom-UI world
 * without an explicit autoFullscreenOnPlay preference. Choosing a mode applies
 * a preview; only confirming persists it. Dismissing (ESC / overlay click)
 * restores the previous mode and saves nothing, so the ask returns next entry.
 */
function AutoFullscreenAskDialog({
  open,
  onOpenChange,
  pendingChoice,
  onPreview,
  onConfirm,
  onRevert,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingChoice: boolean | null;
  onPreview: (enable: boolean) => void;
  onConfirm: () => void;
  onRevert: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("chat");
  const [secondsRemaining, setSecondsRemaining] = useState(
    DISPLAY_MODE_CONFIRM_TIMEOUT_MS / 1_000,
  );
  const confirmationStep = getDisplayModeConfirmationStep(pendingChoice);

  useEffect(() => {
    if (!open || confirmationStep !== "confirm") return;

    const deadline = Date.now() + DISPLAY_MODE_CONFIRM_TIMEOUT_MS;
    const timer = window.setInterval(() => {
      const next = getDisplayModeSecondsRemaining(deadline);
      setSecondsRemaining(next);
      if (next === 0) {
        window.clearInterval(timer);
        onRevert();
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [open, confirmationStep, onRevert]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && confirmationStep === "confirm") {
      onCancel();
      return;
    }
    onOpenChange(nextOpen);
  };

  const handlePreview = (enable: boolean) => {
    setSecondsRemaining(DISPLAY_MODE_CONFIRM_TIMEOUT_MS / 1_000);
    onPreview(enable);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        {confirmationStep === "choose" ? (
          <>
            <div className="flex flex-col items-center gap-2.5 pt-1 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-gold/30 bg-gold/15">
                <Maximize aria-hidden="true" className="h-5 w-5 text-gold" />
              </div>
              <DialogHeader>
                <DialogTitle className="text-center text-lg">{t("view.fullscreenAskTitle")}</DialogTitle>
                <DialogDescription className="max-w-[22rem] text-center text-sm leading-relaxed">
                  {t("view.fullscreenAskBody")}
                </DialogDescription>
              </DialogHeader>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handlePreview(false)}
                className="group flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-4 transition-colors hover:border-white/25 hover:bg-white/[0.07] active:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Minimize aria-hidden="true" className="h-5 w-5 text-foreground/50 transition-colors group-hover:text-foreground/80" />
                <span className="text-sm font-medium text-foreground/75 transition-colors group-hover:text-foreground">
                  {t("view.fullscreenAskNo")}
                </span>
              </button>
              <button
                type="button"
                onClick={() => handlePreview(true)}
                className="group flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-gold/40 bg-gold/10 px-3 py-4 transition-colors hover:border-gold/70 hover:bg-gold/20 active:bg-gold/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Maximize aria-hidden="true" className="h-5 w-5 text-gold" />
                <span className="text-sm font-medium text-gold">{t("view.fullscreenAskYes")}</span>
              </button>
            </div>
            <p className="text-center text-[11px] leading-relaxed text-muted-foreground/60">
              {t("view.fullscreenAskHint")}
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-col items-center gap-3 pt-1 text-center">
              <div className="flex h-14 min-w-14 items-center justify-center rounded-2xl border border-gold/30 bg-gold/15 px-3 text-xl font-semibold tabular-nums text-gold">
                {secondsRemaining}
              </div>
              <DialogHeader>
                <DialogTitle className="text-center text-lg">
                  {t("view.displayModeConfirmTitle")}
                </DialogTitle>
                <DialogDescription className="max-w-[22rem] text-center text-sm leading-relaxed">
                  {t("view.displayModeConfirmBody")}
                </DialogDescription>
              </DialogHeader>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <span className="text-xs text-muted-foreground">{t("view.displayModeCurrent")}</span>
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                {pendingChoice ? (
                  <Maximize aria-hidden="true" className="h-4 w-4 text-gold" />
                ) : (
                  <Minimize aria-hidden="true" className="h-4 w-4 text-gold" />
                )}
                {t(pendingChoice ? "view.displayModeFullscreen" : "view.displayModeWindowed")}
              </span>
            </div>
            <p role="status" aria-atomic="true" className="text-center text-xs font-medium text-gold/90">
              {t("view.displayModeRevertsIn", { count: secondsRemaining })}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={onRevert}
                className="min-h-11 cursor-pointer rounded-xl border border-white/10 bg-white/[0.03] px-4 text-sm font-medium text-foreground/75 transition-colors hover:border-white/25 hover:bg-white/[0.07] hover:text-foreground active:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {t("view.displayModeRevert")}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="min-h-11 cursor-pointer rounded-xl border border-gold/50 bg-gold/15 px-4 text-sm font-semibold text-gold transition-colors hover:border-gold/80 hover:bg-gold/25 active:bg-gold/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {t("view.displayModeKeep")}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The old F11 hint toast is gone: leaving fullscreen reveals the floating bar,
// whose "Return to fullscreen" button already carries an F11 kbd badge on
// pointer devices. The affordance is on screen, so it needs no pill.

/**
 * Shell-level dialog displaying the latest assistant message's pre-parse LLM
 * output. Controlled — mounted at ChatView root so it bypasses customUI iframes
 * and remains reachable in every mode (fullscreen, theater, regular).
 *
 * Always renders when `open` so the keyboard shortcut never silently fails:
 * if there is no raw output to show, displays an explanatory placeholder
 * instead of returning null.
 */
function RawOutputDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const messages = useChatStore((s) => s.messages);

  const latestAssistantRaw = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const swipeIdx = m.activeSwipeIndex ?? 0;
      const raw = m.swipes?.[swipeIdx]?.rawContent;
      if (raw && raw.length > 0) return { raw, content: m.content };
      break;
    }
    return null;
  }, [messages]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>原始 LLM 输出</DialogTitle>
        </DialogHeader>
        {latestAssistantRaw ? (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/85 whitespace-pre-wrap break-all">
              {latestAssistantRaw.raw}
            </div>
            {latestAssistantRaw.raw === latestAssistantRaw.content && (
              <p className="text-xs text-muted-foreground/60">
                原始输出与渲染内容相同 — 这条回复没有被解析吞掉任何东西。
              </p>
            )}
          </>
        ) : (
          <div className="rounded-md border border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            最新一条 AI 回复没有原始输出记录。
            <br />
            <span className="text-xs text-muted-foreground/60">
              该功能 2026-05-14 上线，之前生成的消息无法回溯。
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Bundles the two entry points to the raw-output dialog:
 *   1. Global `Ctrl/Cmd+Shift+L` keyboard shortcut (avoids browser-reserved
 *      Ctrl+Shift+O which opens the bookmark manager).
 *   2. `window.postMessage({ type: "yumina:view-raw-output" })` — lets customUI
 *      sandbox creators wire their own affordances (a button inside the VN bar,
 *      a long-press on a portrait, etc.) without us prescribing visual style.
 *
 * The message bubble's own menu ("Show raw output") is the discoverable third
 * way in, which is why the old one-time hint toast is gone.
 */
function useRawOutputTrigger(isActive: boolean) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== "object" || e.data === null) return;
      if ((e.data as { type?: unknown }).type === "yumina:view-raw-output") {
        setOpen(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isActive]);

  // The "raw AI output available" nag is gone (R8): it taught a hotkey three
  // times per browser for something the bubble menu already offers on every
  // message ("Show raw output"), and Ctrl/⌘+Shift+L still opens the dialog.

  return { open, setOpen };
}

function FullscreenFloatingBar({
  moderationGroupKey,
  onBack,
  revealNonce = 0,
  memorySummaryEnabled = false,
}: {
  moderationGroupKey?: string;
  onBack: () => void;
  /** Bumped by ChatView on every theater→windowed transition; each bump re-reveals the bar. */
  revealNonce?: number;
  /** Session-memory extension installed → show the Memory entry. The bar is
   *  the guaranteed way into the panel for worlds whose custom UI never
   *  renders the composer slots (no Memory pill). */
  memorySummaryEnabled?: boolean;
}) {
  const { t } = useTranslation("chat");
  const { toggle } = useImmersiveMode();
  const reviewGroupKey = moderationGroupKey;
  const guardInstalled = useExtensionsStore((s) => s.installState["state-update-guard"] === "installed");
  const { i18n } = useTranslation();
  const isTouch = useTouchDevice();
  const [visible, setVisible] = useState(false);
  const [modelBrowserOpen, setModelBrowserOpen] = useState(false);
  const selectedModel = useConfigStore((s) => s.selectedModel);
  const setConfig = useConfigStore((s) => s.setConfig);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Set while the cursor rests on the bar. Without it the top-edge reveals —
  // which keep firing as the pointer travels across the bar — would re-arm the
  // auto-hide underneath a user who is hovering it, and the bar would vanish
  // mid-reach.
  const hoverHoldRef = useRef(false);
  const menuOpenRef = useRef(false);

  // Touch gets the longer window: there is no hover to hold the bar open, and
  // ~2.5s minus the slide-in left barely a beat to read it and land a tap.
  const scheduleHide = useCallback(() => {
    clearTimeout(timerRef.current);
    if (shouldPauseFloatingBarAutoHide(hoverHoldRef.current, menuOpenRef.current)) return;
    timerRef.current = setTimeout(() => setVisible(false), isTouch ? 5000 : 3000);
  }, [isTouch]);

  const reveal = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  // Hidden by default so the bar never obstructs the card — revealed on exit
  // from immersive mode (revealNonce), on the top edge, or via the handle below.
  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Re-reveal every time the player drops out of immersive mode.
  useEffect(() => {
    if (revealNonce === 0) return;
    reveal();
  }, [revealNonce, reveal]);

  // Reveal on a deliberate mouse edge-slam (desktop). Same gate as the
  // sandbox reporter: only the outermost strip, never the wider band — a
  // cursor parked where the user is reading must not summon the bar
  // (@burlingk). This listener covers parent-owned chrome; the sandbox
  // forwards its own hits (see below).
  useEffect(() => {
    if (isTouch) return;
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= TOP_EDGE_ALWAYS_PX) reveal();
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [isTouch, reveal]);

  // Reveal on touch near top edge (mobile/tablet — no hover available).
  // Touch keeps the wide band: taps are discrete and deliberate.
  useEffect(() => {
    if (!isTouch) return;
    const onTouch = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? Infinity;
      if (y <= TOP_EDGE_PX) reveal();
    };
    window.addEventListener("touchstart", onTouch, { passive: true });
    return () => window.removeEventListener("touchstart", onTouch);
  }, [isTouch, reveal]);

  // The two listeners above can only ever fire over parent-owned chrome: the
  // world's sandbox iframe covers the whole play viewport, and events inside an
  // iframe never bubble out to the embedder. The sandbox therefore forwards its
  // own top-edge hits, which is what actually makes "hover/tap the top edge"
  // work over a card.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== "object" || e.data === null) return;
      if ((e.data as { type?: unknown }).type === "yumina:top-edge") reveal();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [reveal]);

  const handleMouseEnter = () => {
    if (isTouch) return;
    hoverHoldRef.current = true;
    clearTimeout(timerRef.current);
    setVisible(true);
  };
  const handleMouseLeave = () => {
    if (isTouch) return;
    hoverHoldRef.current = false;
    scheduleHide();
  };

  // F11 handler (desktop only)
  useEffect(() => {
    if (isTouch) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle, isTouch]);

  return (
    <>
      {/* Touch-only visible handle, rendered in the parent document so it sits
          above the sandbox iframe. Desktop doesn't need one — top-edge hover and
          F11 both work there — but on a phone there is no hover, no F11 and no
          ESC, so a purely gestural reveal is the same as no affordance at all.
          Hidden while the bar is up so the two can't collide on a narrow screen.

          Shape and placement are load-bearing. This is a parent-document hit
          target parked on top of somebody's card, and unlike the top-edge band
          it cannot defer to what is underneath: the band's touch gate skips
          taps that land on a card control (shouldRevealTopEdge +
          isInteractiveTarget in the sandbox reporter), but a real button here
          eats every tap inside its box. It used to be a 38x38 pad at
          `right-4 top-4`, i.e. exactly where cards put settings/close — on a
          390px phone it covered the top-right corner from x=vw-54 to x=vw-16
          and swallowed the gear of "Poison in the Bottle · Battle Royale"
          (reported 2026-08-30) plus ~300 other published custom-UI worlds that
          anchor a control there.

          So: a drawer grabber flush to the top edge, horizontally centred,
          where cards put titles and status text rather than buttons. It stays
          deliberately small because it does not have to be the tap target —
          the whole TOP_EDGE_PX band already reveals the bar, and that path
          yields to card controls. This is only the affordance that teaches it. */}
      {isTouch && !visible && (
        <div
          className="fixed left-1/2 z-40 -translate-x-1/2"
          style={{ top: "env(safe-area-inset-top, 0px)" }}
        >
          <button
            onClick={reveal}
            className="flex h-3.5 w-14 items-center justify-center rounded-b-md bg-black/55 text-white/55 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
            title={t("view.showPlayControls")}
            aria-label={t("view.showPlayControls")}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      )}
      <div
        data-admin-review-preview={moderationGroupKey ? "true" : undefined}
        className={`animate-float-bar-in fixed left-1/2 z-50 flex max-w-[calc(100vw-1rem)] items-center gap-1.5 rounded-2xl border border-gold/25 bg-[#14151a]/88 p-1.5 shadow-[0_18px_45px_rgba(0,0,0,0.42),0_0_28px_rgba(201,162,94,0.08)] backdrop-blur-xl transition-[top,opacity] duration-500 ${
          visible
            ? "top-[max(1rem,env(safe-area-inset-top))] opacity-100"
            : "pointer-events-none -top-32 opacity-0"
        }`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <FullscreenFloatingControls
          backLabel={
            reviewGroupKey ? t("view.backToReview", "返回审核") : t("view.backToLibrary")
          }
          moreLabel={t("header.moreActions")}
          modelLabel={t("view.switchModel")}
          memoryLabel={memorySummaryEnabled ? t("view.memoryPanel") : undefined}
          stateGuardLabel={guardInstalled ? guardLabels(i18n.language)[0] : undefined}
          onStateGuard={() => {
            window.dispatchEvent(new CustomEvent("yumina:request-state-guard"));
            setVisible(false);
          }}
          fullscreenLabel={t("view.returnToFullscreen")}
          showActions={!(isTouch && reviewGroupKey)}
          onBack={onBack}
          onModel={() => {
            setModelBrowserOpen(true);
            setVisible(false);
          }}
          onMemory={() => {
            // Handled by WorldRenderer → bridge → sandbox host mount.
            window.dispatchEvent(new CustomEvent("yumina:request-memory-panel"));
            setVisible(false);
          }}
          onFullscreen={toggle}
          onInteractionStart={() => clearTimeout(timerRef.current)}
          onMenuOpenChange={(open) => {
            menuOpenRef.current = open;
            clearTimeout(timerRef.current);
            if (!open) scheduleHide();
          }}
        />
      </div>
      <ChatModelBrowser
        open={modelBrowserOpen}
        onClose={() => setModelBrowserOpen(false)}
        selectedModel={selectedModel}
        onSelect={(id) => {
          setConfig("selectedModel", id);
          useModelsStore.getState().addToRecent(id);
          setModelBrowserOpen(false);
        }}
      />
    </>
  );
}

function ImmersiveExitButton() {
  const { t } = useTranslation("chat");
  const { toggle } = useImmersiveMode();
  const [visible, setVisible] = useState(false);
  const [exitCollapsed, setExitCollapsed] = useState(false);
  const [systemFullscreen, setSystemFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const isTouch = useTouchDevice();
  const canRequestSystemFullscreen =
    isTouch && !isIOS() && Boolean(document.documentElement.requestFullscreen);
  const shouldOfferSystemFullscreen = canRequestSystemFullscreen && !systemFullscreen;

  // Track browser fullscreen state for the manual "enter system fullscreen" button.
  useEffect(() => {
    const onFullscreenChange = () => {
      setSystemFullscreen(Boolean(document.fullscreenElement));
    };
    setSystemFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const exitLayout = getImmersiveExitLayout(isTouch, exitCollapsed);

  useEffect(() => {
    if (!isTouch || exitCollapsed) return;
    const timer = scheduleMobileExitAutoCollapse(
      () => setExitCollapsed(true),
      window.setTimeout.bind(window),
    );
    return () => window.clearTimeout(timer);
  }, [exitCollapsed, isTouch]);

  const handleRequestSystemFullscreen = useCallback(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  const handleExitClick = useCallback(() => {
    if (getMobileExitActivation(isTouch, exitCollapsed) === "expand") {
      setExitCollapsed(false);
      return;
    }
    toggle();
  }, [exitCollapsed, isTouch, toggle]);

  // F11 handler for immersive mode (desktop only)
  useEffect(() => {
    if (isTouch) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle, isTouch]);

  return (
    <div
      className={exitLayout.shellClassName}
      style={exitLayout.shellStyle}
      onMouseEnter={() => !isTouch && setVisible(true)}
      onMouseLeave={() => !isTouch && setVisible(false)}
    >
      {/* Touch controls briefly appear in full, then collapse to a narrow edge tab
          so legacy card controls remain exposed. Desktop keeps its hover controls. */}
      {/* Invisible hover zone (desktop only) */}
      {!isTouch && <div className="h-10 w-10" />}
      {shouldOfferSystemFullscreen && !exitCollapsed ? (
        <button
          onClick={handleRequestSystemFullscreen}
          className={exitLayout.systemFullscreenButtonClassName}
          title={t("view.enterSystemFullscreen")}
          aria-label={t("view.enterSystemFullscreen")}
        >
          <Maximize className="h-4 w-4" />
        </button>
      ) : null}
      <button
        onClick={handleExitClick}
        className={
          isTouch
            ? exitLayout.exitButtonClassName
            : `${exitLayout.exitButtonClassName} ${visible ? "opacity-100 scale-100" : "opacity-0 scale-90"}`
        }
        title={
          isTouch && exitCollapsed
            ? t("view.showImmersiveExit")
            : isTouch
              ? t("view.exitImmersive")
              : t("view.exitFullscreen")
        }
        aria-label={
          isTouch && exitCollapsed
            ? t("view.showImmersiveExit")
            : isTouch
              ? t("view.exitImmersive")
              : t("view.exitFullscreen")
        }
      >
        {exitCollapsed ? (
          <span className="h-5 w-0.5 rounded-full bg-white/80" aria-hidden="true" />
        ) : (
          <Minimize className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

/**
 * The model browser opened from a chat: pass the tokens the next reply will read
 * (the last reply's total token count is the closest thing we have) so the
 * measured cost estimate is scaled to THIS chat instead of the fleet median.
 */
function ChatModelBrowser(props: Omit<Parameters<typeof ModelBrowser>[0], "contextTokens">) {
  const contextTokens = useChatStore((s) => {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const count = s.messages[i]?.tokenCount;
      if (typeof count === "number" && count > 0) return count;
    }
    return null;
  });
  return <ModelBrowser {...props} contextTokens={contextTokens} />;
}
