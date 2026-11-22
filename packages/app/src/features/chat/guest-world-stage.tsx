import { useState, useEffect, useMemo, useRef, useCallback } from "react";
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
import { absoluteImageUrl } from "@/lib/asset-url";
import { useAudioStore } from "@/stores/audio";

// A card running with nobody signed in to it: the guest preview of a card, and
// the preview of a resource pack in the market. Everything the card's own code
// can do locally (variables, actions, audio, switching openings) works; the one
// thing that would reach the AI hands control back through `onLlmRequest`.
// The card's code runs in the same sandboxed frame as real play.

export const GUEST_PREVIEW_CAPABILITIES = {
  canSendMessage: false,
  canPersistSession: false,
  canUseSessionApis: false,
  requiresAuth: true,
} as const;

type RootComponent = NonNullable<WorldDefinition["rootComponent"]>;

function normalizeRootSource(source: string | undefined): string {
  return (source ?? "").replace(/\s+/g, "");
}

function hasPlainChatElement(normalizedSource: string): boolean {
  return /React\.createElement\(Chat(?:,null)?\)/.test(normalizedSource)
    || normalizedSource.includes("return<Chat/>")
    || normalizedSource.includes("return<Chat></Chat>");
}

export function isGeneratedDefaultChatRoot(rootComponent: RootComponent | undefined): boolean {
  if (!rootComponent) return false;
  const fileNames = Object.keys(rootComponent.files ?? {});
  if (fileNames.length !== 1) return false;

  const entry = rootComponent.files[rootComponent.entryFile] ?? rootComponent.files[fileNames[0] ?? ""];
  const normalized = normalizeRootSource(entry);
  return normalized === normalizeRootSource(DEFAULT_CHAT_ROOT)
    || hasPlainChatElement(normalized);
}

export function resolveGuestPreviewRootComponent(
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

/** Local state and the stand-in API for a card nobody is playing. */
export function useGuestPreviewRuntime({
  worldDef,
  worldId,
  worldName,
  worldCover,
  onLlmRequest,
}: {
  worldDef: WorldDefinition | undefined;
  worldId: string;
  worldName: string;
  worldCover: string | null | undefined;
  onLlmRequest: () => void;
}) {
  // Local mutable game state for the guest preview. Custom UIs commonly call
  // `setVariable` / `executeAction` during their initial mount (asset preloaders,
  // splash flow, scene init). Routing those through sign-in pops the
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
  const onLlmRequestRef = useRef(onLlmRequest);
  onLlmRequestRef.current = onLlmRequest;

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
      sendMessage: () => { onLlmRequestRef.current(); },
      setVariable: handleGuestSetVariable,
      executeAction: handleGuestExecuteAction,
      switchGreeting: handleGuestSwitchGreeting,
      mode: "guest-preview",
      capabilities: GUEST_PREVIEW_CAPABILITIES,
      variables,
      globalVariables: variables,
      worldName,
      worldCover: absoluteImageUrl(worldCover),
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
      worldName,
      worldCover,
      handleGuestSetVariable,
      handleGuestExecuteAction,
      handleGuestSwitchGreeting,
    ],
  );

  return { variables, previewAPI };
}

/** The card's own interface, running in the sandbox with guest-preview powers. */
export function GuestWorldStage({
  worldDef,
  rootComponent,
  worldId,
  worldName,
  worldCover,
  onLlmRequest,
  className,
}: {
  worldDef: WorldDefinition;
  rootComponent: RootComponent;
  worldId: string;
  worldName: string;
  worldCover?: string | null;
  onLlmRequest: () => void;
  className?: string;
}) {
  const { variables, previewAPI } = useGuestPreviewRuntime({ worldDef, worldId, worldName, worldCover, onLlmRequest });
  return (
    <WorldRenderer
      entryFile={rootComponent.entryFile}
      files={rootComponent.files}
      precompiled={rootComponent.compiled}
      variables={variables}
      variableDefs={worldDef.variables ?? []}
      api={previewAPI}
      sessionId=""
      worldId={worldId}
      mode="guest-preview"
      capabilities={GUEST_PREVIEW_CAPABILITIES}
      className={className}
      entries={worldDef.entries ?? []}
      loreUiBindings={worldDef.loreUiBindings ?? []}
      worldbooks={worldDef.worldbooks ?? []}
      replyRules={worldDef.replyRules}
    />
  );
}
