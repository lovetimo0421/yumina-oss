import { useGuestSessionStart } from "./use-guest-session-start";
import { useState, useEffect, useMemo, useRef, useCallback, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, Loader2, LogIn } from "lucide-react";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { TopBarAccountControls } from "@/components/layout/top-bar";
import { WorldRenderer } from "./world-renderer";
import { makeVariableKeyResolver } from "./variable-key";
import type { YuminaAPI } from "@/features/studio/lib/custom-component-renderer";
import {
  DEFAULT_CHAT_ROOT,
  GameStateManager,
  ReactionEvaluator,
  applySystemEffects,
  buildActionFiredEvent,
  customUIToRootFiles,
  expandMacros,
  processSystemEffects,
} from "@yumina/engine";
import type { WorldDefinition, AudioTrack, BGMPlaylist, ConditionalBGM } from "@yumina/engine";
import { safeParseWorldDef } from "@/lib/utils";
import { absoluteImageUrl } from "@/lib/asset-url";
import { useUiStore } from "@/stores/ui";
import { useAudioStore } from "@/stores/audio";
import { navigateToStoryReturn, type StoryReturnContext } from "@/lib/story-return";

const apiBase = import.meta.env.VITE_API_URL || "";

const GUEST_PREVIEW_CAPABILITIES = {
  canSendMessage: false,
  canPersistSession: false,
  canUseSessionApis: false,
  requiresAuth: true,
} as const;

interface WorldData {
  id: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  schema: WorldDefinition;
}

type RootComponent = NonNullable<WorldDefinition["rootComponent"]>;

function normalizeRootSource(source: string | undefined): string {
  return (source ?? "").replace(/\s+/g, "");
}

function hasPlainChatElement(normalizedSource: string): boolean {
  return /React\.createElement\(Chat(?:,null)?\)/.test(normalizedSource)
    || normalizedSource.includes("return<Chat/>")
    || normalizedSource.includes("return<Chat></Chat>");
}

function isGeneratedDefaultChatRoot(rootComponent: RootComponent | undefined): boolean {
  if (!rootComponent) return false;
  const fileNames = Object.keys(rootComponent.files ?? {});
  if (fileNames.length !== 1) return false;

  const entry = rootComponent.files[rootComponent.entryFile] ?? rootComponent.files[fileNames[0] ?? ""];
  const normalized = normalizeRootSource(entry);
  return normalized === normalizeRootSource(DEFAULT_CHAT_ROOT)
    || hasPlainChatElement(normalized);
}

function resolveGuestPreviewRootComponent(
  worldDef: WorldDefinition | undefined,
  rawSchema: unknown,
): RootComponent | undefined {
  const rootComponent = worldDef?.rootComponent;
  if (!rootComponent || !isGeneratedDefaultChatRoot(rootComponent)) return rootComponent;

  const legacyCustomUI = Array.isArray((rawSchema as { customUI?: unknown })?.customUI)
    ? (rawSchema as { customUI: Parameters<typeof customUIToRootFiles>[0] }).customUI
    : [];
  if (legacyCustomUI.length === 0) return rootComponent;

  const files = customUIToRootFiles(legacyCustomUI);
  const migratedRoot = {
    ...rootComponent,
    files,
    entryFile: "index.tsx",
  };

  return isGeneratedDefaultChatRoot(migratedRoot) ? rootComponent : migratedRoot;
}

type GuestVariableValue = number | string | boolean | Record<string, unknown> | unknown[];
type GuestVariables = Record<string, GuestVariableValue>;

/** Pre-written greeting bodies for the world, in display order. Used both for the
 *  initial preview message and for `switchGreeting()` swipes from custom UI. */
function collectGreetings(worldDef: WorldDefinition | undefined): string[] {
  if (!worldDef) return [];
  const fromEntries = (worldDef.entries ?? [])
    .filter((entry) => entry.role === "greeting" && entry.enabled !== false)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((entry) => (entry.content ?? "").trim())
    .filter(Boolean);
  if (fromEntries.length > 0) return fromEntries;
  const fallback = (worldDef.settings as { greeting?: string } | undefined)?.greeting?.trim();
  return fallback ? [fallback] : [];
}

function expandGreeting(
  worldDef: WorldDefinition | undefined,
  raw: string | undefined,
  variables: GuestVariables,
): string | null {
  if (!worldDef || !raw) return null;
  return expandMacros(raw, worldDef, {
    variables,
    turnCount: 0,
    metadata: { personaName: "Player" },
  } as any);
}

/**
 * Client-side world preview for guests.
 * Fetches the world schema from the public API and renders the full chat UI
 * (greeting, widgets, custom components) inside a sandboxed iframe.
 * All interactive actions are gated behind authentication.
 */
export function WorldPreview({
  worldId,
  returnContext,
}: {
  worldId: string;
  returnContext: StoryReturnContext;
}) {
  const { t } = useTranslation("chat");
  const router = useRouter();
  const { requireAuth, isAuthenticated } = useAuthGuard();
  const [world, setWorld] = useState<WorldData | null>(null);
  const [loading, setLoading] = useState(true);
  const playZoomPercent = useUiStore((s) => s.playZoomPercent);
  const handleBack = useCallback(() => {
    navigateToStoryReturn(router.history, returnContext);
  }, [returnContext, router.history]);

  // ── Fetch world schema ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/worlds/${worldId}`, {
          credentials: "include",
        });
        if (res.ok) {
          const { data } = await res.json();
          setWorld(data);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    })();
  }, [worldId]);

  const { startError, retryStart } = useGuestSessionStart(isAuthenticated && world?.id === worldId, worldId, returnContext);

  // ── Derived data (ALL hooks before any early return) ────────────
  const worldDef = useMemo<WorldDefinition | undefined>(
    () => safeParseWorldDef(world?.schema),
    [world?.schema],
  );

  // Local mutable game state for the guest preview. Custom UIs commonly call
  // `setVariable` / `executeAction` during their initial mount (asset preloaders,
  // splash flow, scene init). Routing those through requireAuth() pops the
  // sign-in modal before the user can even see the card; instead we apply them
  // to a local React state so non-LLM behaviour works without an account.
  // `sendMessage` (which is the only path that actually triggers the LLM) is
  // still gated below.
  const [variables, setVariables] = useState<GuestVariables>({});
  const [greetingIndex, setGreetingIndex] = useState(0);

  // Reset local state whenever the world definition changes (new card loaded).
  useEffect(() => {
    if (!worldDef) {
      setVariables({});
      setGreetingIndex(0);
      return;
    }
    const gsm = new GameStateManager(worldDef);
    setVariables(gsm.getSnapshot().variables as GuestVariables);
    setGreetingIndex(0);
  }, [worldDef]);

  // ── Initialize BGM for guest preview ─────────────────────────────
  useEffect(() => {
    if (!worldDef) return;
    const audioStore = useAudioStore.getState();
    audioStore.cleanup();

    const tracks = worldDef.audioTracks;
    if (tracks && Array.isArray(tracks) && tracks.length > 0) {
      audioStore.setTracks(tracks as AudioTrack[]);

      if (worldDef.bgmPlaylist) {
        audioStore.setPlaylist(worldDef.bgmPlaylist as BGMPlaylist);
      }
      if (worldDef.conditionalBGM && Array.isArray(worldDef.conditionalBGM)) {
        audioStore.setConditionalRules(worldDef.conditionalBGM as ConditionalBGM[]);
      }

      // Auto-start playlist (waitForFirstMessage is irrelevant in preview — start immediately)
      const pl = worldDef.bgmPlaylist as BGMPlaylist | undefined;
      if (pl?.autoPlay && pl.tracks.length > 0) {
        audioStore.startPlaylist();
      }

      // Evaluate against fresh defaults rather than the still-empty `variables`
      // state (which is populated by the worldDef-keyed effect above on the
      // next tick). Subsequent variable changes are picked up by the BGM
      // re-eval effect below.
      const initialVars = new GameStateManager(worldDef).getSnapshot().variables;
      audioStore.evaluateConditionalBGM({
        worldId: worldId,
        variables: initialVars as GuestVariables,
        turnCount: 0,
        metadata: {},
        isSessionStart: true,
      });
    }

    return () => {
      useAudioStore.getState().cleanup();
    };
  }, [worldDef, worldId]);

  // Re-evaluate conditional BGM whenever local variables change (skip the
  // empty initial render to avoid clobbering the isSessionStart pass above).
  useEffect(() => {
    if (!worldDef) return;
    if (Object.keys(variables).length === 0) return;
    useAudioStore.getState().evaluateConditionalBGM({
      worldId,
      variables,
      turnCount: 0,
      metadata: {},
    });
  }, [variables, worldDef, worldId]);

  // Every world is v2 with rootComponent (migrateWorldDefinition guarantees it).
  // Guest preview also repairs the legacy edge case where a default rootComponent
  // masks an older customUI card in the public schema.
  const rootComponent = useMemo(
    () => resolveGuestPreviewRootComponent(worldDef, world?.schema),
    [worldDef, world?.schema],
  );
  const isDefaultChatPreview = isGeneratedDefaultChatRoot(rootComponent);

  // List of available greetings (for switchGreeting + swipe rendering)
  const greetings = useMemo(() => collectGreetings(worldDef), [worldDef]);

  const greetingContent = useMemo(
    () => expandGreeting(worldDef, greetings[greetingIndex] ?? greetings[0], variables),
    [worldDef, greetings, greetingIndex, variables],
  );

  // Synthetic message list. Many cards iterate `api.messages` directly to render
  // chat bubbles and assume the greeting is already there (in session mode the
  // server inserts it as the first assistant message — see sessions.ts:118).
  // Mirror that here so guest previews show the greeting in those cards too.
  const previewMessages = useMemo<Array<Record<string, unknown>>>(() => {
    if (!greetingContent) return [];
    const expandedSwipes = greetings
      .map((raw) => expandGreeting(worldDef, raw, variables))
      .filter((c): c is string => Boolean(c))
      .map((content) => ({ content, createdAt: new Date(0).toISOString() }));
    return [
      {
        id: "__guest_preview_greeting__",
        sessionId: "",
        role: "assistant",
        content: greetingContent,
        createdAt: new Date(0).toISOString(),
        swipes: expandedSwipes,
        activeSwipeIndex: Math.min(greetingIndex, Math.max(0, expandedSwipes.length - 1)),
      },
    ];
  }, [greetingContent, greetings, greetingIndex, worldDef, variables]);

  // ── Preview API — auth-gated only for LLM-bound paths ───────────
  const requireAuthRef = useRef(requireAuth);
  requireAuthRef.current = requireAuth;

  // Track latest variables in a ref so executeAction can read them without
  // recreating the previewAPI on every change (which would still be correct,
  // but wastes work). The setVariable callback is deliberately stable.
  const variablesRef = useRef<GuestVariables>(variables);
  variablesRef.current = variables;

  // Same id-else-display-name resolution the session path uses, so a preview
  // behaves like the real thing (see ./variable-key.ts).
  const resolveVariableKey = useMemo(
    () => makeVariableKeyResolver(worldDef?.variables),
    [worldDef?.variables],
  );

  const handleGuestSetVariable = useCallback<YuminaAPI["setVariable"]>((rawId, value) => {
    const id = resolveVariableKey(rawId);
    setVariables((prev) => {
      const prevValue = prev[id];
      if (prevValue === value) return prev;
      return { ...prev, [id]: value as GuestVariableValue };
    });
  }, [resolveVariableKey]);

  const handleGuestExecuteAction = useCallback((actionId: string) => {
    if (!worldDef) return;
    try {
      const evaluator = new ReactionEvaluator();
      const baseState = {
        worldId: worldDef.id,
        variables: { ...variablesRef.current },
        turnCount: 0,
        metadata: {},
      };
      const result = evaluator.evaluate(
        buildActionFiredEvent(actionId),
        worldDef.reactions ?? [],
        worldDef.rules,
        baseState as any,
      );
      const sysResult = processSystemEffects(result.effects);
      if (
        sysResult.variableEffects.length === 0
        && sysResult.audioEffects.length === 0
      ) {
        return;
      }
      const gsm = new GameStateManager(worldDef, baseState as any);
      applySystemEffects(gsm, sysResult);
      const nextVars = gsm.getSnapshot().variables as GuestVariables;
      setVariables(nextVars);
      if (sysResult.audioEffects.length > 0) {
        useAudioStore.getState().processAudioEffects(sysResult.audioEffects);
      }
    } catch (err) {
      // Best-effort: never crash the preview because of a single broken action.
      console.warn("[WorldPreview] executeAction failed:", err);
    }
  }, [worldDef]);

  const handleGuestSwitchGreeting = useCallback((index: number) => {
    if (!Number.isInteger(index)) return;
    if (index < 0 || index >= greetings.length) return;
    setGreetingIndex(index);
  }, [greetings.length]);

  const previewAPI = useMemo<YuminaAPI>(
    () => ({
      // Only the LLM entry point gates on auth. Everything else is a local
      // operation that should be visible to a logged-out viewer.
      sendMessage: () => { requireAuthRef.current("continue the story"); },
      setVariable: handleGuestSetVariable,
      executeAction: handleGuestExecuteAction,
      switchGreeting: handleGuestSwitchGreeting,
      mode: "guest-preview",
      capabilities: GUEST_PREVIEW_CAPABILITIES,
      variables,
      globalVariables: variables,
      worldName: world?.name ?? "",
      worldCover: absoluteImageUrl(world?.thumbnailUrl),
      currentUser: null,
      messages: previewMessages,
      isStreaming: false,
      streamingContent: "",
      readOnly: true,
      greetingContent,
      playAudio: (trackId, opts) => useAudioStore.getState().playTrack(trackId, opts),
      stopAudio: (trackId, fadeDuration) => { if (trackId) useAudioStore.getState().stopTrack(trackId, fadeDuration); else useAudioStore.getState().stopAll(); },
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
    [
      variables,
      previewMessages,
      greetingContent,
      world?.name,
      world?.thumbnailUrl,
      handleGuestSetVariable,
      handleGuestExecuteAction,
      handleGuestSwitchGreeting,
    ],
  );

  const playZoomStyle = useMemo(
    () =>
      ({
        "--play-ui-scale": `${playZoomPercent / 100}`,
      }) as CSSProperties,
    [playZoomPercent],
  );

  const characterName = useMemo(() => {
    if (!worldDef) return "";
    return worldDef.characters?.[0]?.name ?? world?.name ?? "AI";
  }, [worldDef, world?.name]);

  // World preview renders via v2 WorldRenderer (same path as real play).
  // extraProps / canvasMode existed only for the deleted v1 SandboxedRenderer.

  // ── Early returns (all hooks are above) ─────────────────────────
  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  if (!world || !worldDef) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground/50">{t("preview.worldNotFound")}</p>
        <button
          onClick={handleBack}
          className="text-sm text-primary hover:underline"
        >
          {t("replay.back")}
        </button>
      </div>
    );
  }

  if (startError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6" role="alert">
        <p>{t("failedStartSession", { ns: "toasts" })}</p>
        <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground" onClick={retryStart}>{t("action.retry", { ns: "common" })}</button>
        <button className="px-4 py-2 text-primary" onClick={handleBack}>{t("replay.back")}</button>
      </div>
    );
  }

  // ── Shared sign-up banner (consistent across all preview modes) ──
  const signUpBanner = (
    <div
      className="shrink-0 z-50 flex items-center justify-center gap-3 border-t border-white/10 bg-[#0C0C0E]/95 px-4 pt-3 backdrop-blur-md"
      style={{ paddingBottom: "calc(0.75rem + var(--mobile-safe-bottom))" }}
    >
      <button
        onClick={() => requireAuth("continue playing")}
        className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <LogIn className="h-3.5 w-3.5" />
        {t("preview.signUpToPlay")}
      </button>
    </div>
  );

  const previewHeader = (
    <div className="play-header-shell shrink-0 border-b border-border">
      <div className="play-header-inner play-preview-header">
        <div className="play-header-leading">
          <button
            onClick={handleBack}
            aria-label={t("replay.back")}
            title={t("replay.back")}
            className="play-header-icon-button hover-surface rounded-md text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="play-header-title-group min-w-0 flex-1 overflow-hidden">
            <h2 className="play-header-title truncate text-[0.95rem] font-medium text-foreground">{world.name}</h2>
            <p className="play-header-subtitle truncate text-xs text-muted-foreground/50">{characterName}</p>
          </div>
        </div>
        <div className="play-header-account">
          <TopBarAccountControls />
        </div>
      </div>
    </div>
  );

  // Every world renders through the v2 rootComponent pipeline — same runtime
  // as real play. Legacy v1 fullscreen/canvas forks were deleted in phase 5.
  if (!rootComponent) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {world.name} has no rootComponent. Schema may be corrupted.
      </div>
    );
  }

  if (isDefaultChatPreview) {
    return (
      <div className="play-page-root flex h-full w-full flex-col overflow-hidden" style={playZoomStyle}>
        {previewHeader}
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[#0D0E11] p-6">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <p className="text-sm text-muted-foreground">{t("preview.signInToSend")}</p>
            <button
              onClick={() => requireAuth("continue playing")}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <LogIn className="h-3.5 w-3.5" />
              {t("preview.signUpToStart")}
            </button>
          </div>
        </div>
        {signUpBanner}
      </div>
    );
  }

  return (
    <div className="play-page-root flex h-full w-full flex-col overflow-hidden" style={playZoomStyle}>
      {previewHeader}
      <WorldRenderer
        entryFile={rootComponent.entryFile}
        files={rootComponent.files}
        variables={variables}
        variableDefs={worldDef?.variables ?? []}
        api={previewAPI}
        sessionId=""
        worldId={worldId}
        mode="guest-preview"
        capabilities={GUEST_PREVIEW_CAPABILITIES}
        className="flex-1 min-h-0"
        entries={worldDef?.entries ?? []}
        loreUiBindings={worldDef?.loreUiBindings ?? []}
        worldbooks={worldDef?.worldbooks ?? []}
      />
      {signUpBanner}
    </div>
  );
}
