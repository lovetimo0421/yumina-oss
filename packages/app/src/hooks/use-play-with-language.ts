import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useNavigate } from "@tanstack/react-router";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import { useUiStore } from "@/stores/ui";
import { useLibraryStore } from "@/stores/library";
import { fetchCreditsForChat } from "@/edition/slots.state";
import { getPlansHref } from "@/edition/routes";
import type { LanguageVariant } from "@/lib/languages";
import { SessionPickerModal } from "@/components/session-picker-modal";
import { ContextGateModal, type ContextGateInfo, type WorldContextRequirement } from "@/components/context-gate-modal";
import { getEffectiveContextInfo, raiseMaxContext } from "@/lib/context-budget";
import { recordWorldHistoryClick, type WorldHistoryInteraction, type WorldHistorySource } from "@/lib/history-clicks";
import { captureStoryReturnContext, type StoryReturnContext } from "@/lib/story-return";

const apiBase = import.meta.env.VITE_API_URL || "";

// This module is a hook + store, so it has no useTranslation of its own.
const tr = (key: string, fallback: string, opts?: Record<string, unknown>) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, {
    defaultValue: fallback,
    ...opts,
  });

/** R7: the play flow has no inline surface — the picker closed or never opened. */
function startSessionFailed() {
  feedback.error(tr("chat:play.startFailed", "Couldn't start the session"));
}

export interface PlayableWorld {
  id: string;
  name: string;
  thumbnailUrl?: string | null;
  language?: string | null;
  languageGroupId?: string | null;
  /** Set = a game card (worlds.game_path): play skips the picker and goes straight in. */
  gamePath?: string | null;
}

interface UsePlayWithLanguageOptions {
  onNavigate: (sessionId: string, returnContext: StoryReturnContext) => void;
  onSessionCreated?: (data: { id: string; addedToLibrary?: boolean }) => void;
  historySource?: WorldHistorySource;
  historyInteraction?: WorldHistoryInteraction;
}

interface PlaySessionPickerState {
  open: boolean;
  variants: LanguageVariant[];
  pendingWorld: PlayableWorld | null;
  creating: boolean;
  onNavigate: ((sessionId: string, returnContext: StoryReturnContext) => void) | null;
  onSessionCreated: ((data: { id: string; addedToLibrary?: boolean }) => void) | null;
  returnContext: StoryReturnContext | null;
  /** Pre-play context warning — when set, the session picker stays closed
   * until the user picks Ignore or Raise. */
  contextGate: ContextGateInfo | null;
}

const initialPickerState: PlaySessionPickerState = {
  open: false,
  variants: [],
  pendingWorld: null,
  creating: false,
  onNavigate: null,
  onSessionCreated: null,
  returnContext: null,
  contextGate: null,
};

const usePlaySessionPickerStore = create<PlaySessionPickerState>(() => initialPickerState);

let flowResolve: (() => void) | null = null;
let variantsAbortController: AbortController | null = null;
let creatingInFlight = false;

function resetPickerState(overrides?: Partial<PlaySessionPickerState>) {
  usePlaySessionPickerStore.setState({
    ...initialPickerState,
    ...overrides,
  });
}

function resolveCurrentFlow() {
  flowResolve?.();
  flowResolve = null;
}

function recordRecentPlayedWorld(world: PlayableWorld) {
  useUiStore.getState().recordRecentPlayedWorld({
    id: world.id,
    name: world.name,
    thumbnailUrl: world.thumbnailUrl,
  });
  useLibraryStore.getState().markPlayed(world.id);
}

// ── Pre-play context requirement gate ────────────────────────────────────────
// Successful lookups are cached per world (requirement only changes when the
// world is re-saved, and the server caches per version anyway). Failures are
// NOT cached and the whole gate fails open — a missing warning must never
// block play.
const requirementCache = new Map<string, WorldContextRequirement>();

async function fetchContextRequirement(worldId: string): Promise<WorldContextRequirement | null> {
  const cached = requirementCache.get(worldId);
  if (cached) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${apiBase}/api/worlds/${worldId}/context-requirement`, {
      credentials: "include",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    if (!data || typeof data.requiredTokens !== "number") return null;
    requirementCache.set(worldId, data as WorldContextRequirement);
    return data as WorldContextRequirement;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function PlaySessionPickerHost() {
  const open = usePlaySessionPickerStore((state) => state.open);
  const variants = usePlaySessionPickerStore((state) => state.variants);
  const pendingWorld = usePlaySessionPickerStore((state) => state.pendingWorld);
  const creating = usePlaySessionPickerStore((state) => state.creating);
  const contextGate = usePlaySessionPickerStore((state) => state.contextGate);

  const handleClose = useCallback(() => {
    variantsAbortController?.abort();
    variantsAbortController = null;
    resetPickerState();
    resolveCurrentFlow();
  }, []);

  // Context gate actions: both proceed into the session picker — Raise also
  // lifts the user's context setting first.
  const handleGateIgnore = useCallback(() => {
    usePlaySessionPickerStore.setState({ contextGate: null, open: true });
  }, []);

  const handleGateRaise = useCallback(() => {
    const gate = usePlaySessionPickerStore.getState().contextGate;
    if (gate) {
      const value = raiseMaxContext(gate.requirement.requiredTokens);
      // The gate modal closes and the session picker opens on top, so the new
      // context setting is nowhere on screen — a neutral notice, not a success.
      feedback.notice(
        tr("chat:play.contextRaised", "Context set to {{value}} tokens", {
          value: value.toLocaleString(),
        }),
      );
    }
    usePlaySessionPickerStore.setState({ contextGate: null, open: true });
  }, []);

  // Card needs more context than the plan allows — leave the play flow and
  // take the user to the plans page.
  const navigate = useNavigate();
  const handleGateUpgrade = useCallback(() => {
    handleClose();
    const plansHref = getPlansHref("subscription");
    if (plansHref) void navigate({ to: plansHref });
  }, [handleClose, navigate]);

  const handleSelectSession = useCallback((sessionId: string) => {
    const state = usePlaySessionPickerStore.getState();
    const world = state.pendingWorld;
    const navigate = state.onNavigate;

    resetPickerState();

    if (world) {
      recordRecentPlayedWorld(world);
    }

    navigate?.(sessionId, state.returnContext ?? {});
    resolveCurrentFlow();
  }, []);

  const handleCreateSession = useCallback(async (worldId: string) => {
    if (creatingInFlight) return;

    const state = usePlaySessionPickerStore.getState();
    const world = state.pendingWorld ?? { id: worldId, name: "" };
    const navigate = state.onNavigate;

    creatingInFlight = true;
    usePlaySessionPickerStore.setState({ creating: true, open: false });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(`${apiBase}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ worldId }),
        signal: controller.signal,
      });

      if (!res.ok) {
        startSessionFailed();
        usePlaySessionPickerStore.setState({ creating: false, open: true });
        resolveCurrentFlow();
        return;
      }

      const { data } = await res.json();
      state.onSessionCreated?.(data);
      resetPickerState();
      recordRecentPlayedWorld(world);
      navigate?.(data.id, state.returnContext ?? {});
      resolveCurrentFlow();
    } catch {
      startSessionFailed();
      usePlaySessionPickerStore.setState({ creating: false, open: true });
      resolveCurrentFlow();
    } finally {
      clearTimeout(timeout);
      creatingInFlight = false;
    }
  }, []);

  if (!pendingWorld) return null;

  if (contextGate) {
    return createElement(ContextGateModal, {
      worldName: pendingWorld.name,
      gate: contextGate,
      onIgnore: handleGateIgnore,
      onRaise: handleGateRaise,
      onUpgrade: handleGateUpgrade,
      onClose: handleClose,
    });
  }

  return createElement(SessionPickerModal, {
    open,
    onClose: handleClose,
    onSelectSession: handleSelectSession,
    onCreateSession: handleCreateSession,
    world: pendingWorld,
    variants,
    creating,
  });
}

export function usePlayWithLanguage(options: UsePlayWithLanguageOptions) {
  const { onNavigate, onSessionCreated, historySource, historyInteraction } = options;
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolveFlowForHook = useCallback((resolve: () => void) => {
    flowResolve = () => {
      resolve();
      if (mountedRef.current) {
        setLoading(false);
      }
    };
  }, []);

  const handlePlay = useCallback(
    (world: PlayableWorld): Promise<void> => {
      if (loading) return Promise.resolve();

      variantsAbortController?.abort();

      return new Promise<void>((resolve) => {
        resolveFlowForHook(resolve);
        setLoading(true);
        const returnContext = captureStoryReturnContext();

        if (historySource && historyInteraction) {
          recordWorldHistoryClick({
            worldId: world.id,
            worldName: world.name,
            worldThumbnailUrl: world.thumbnailUrl,
            source: historySource,
            interaction: historyInteraction,
          });
        }

        // A GAME card goes straight to the court: no language variants (one card, one shared
        // player pool -- the game translates its own interface per client), no context gate
        // (there is no AI context), and no session picker (the session row is a receipt, not a
        // book: reuse the newest so the shelf shows one entry per game, not one per click).
        if (world.gamePath) {
          void (async () => {
            try {
              let sessionId: string | null = null;
              const listRes = await fetch(
                `${apiBase}/api/sessions?worldId=${encodeURIComponent(world.id)}`,
                { credentials: "include" },
              );
              if (listRes.ok) {
                const { data } = await listRes.json();
                if (Array.isArray(data) && data.length > 0 && data[0]?.id) sessionId = data[0].id;
              }
              if (!sessionId) {
                const createRes = await fetch(`${apiBase}/api/sessions`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify({ worldId: world.id }),
                });
                if (!createRes.ok) {
                  startSessionFailed();
                  return;
                }
                const { data } = await createRes.json();
                onSessionCreated?.(data);
                sessionId = data.id;
              }
              recordRecentPlayedWorld(world);
              if (sessionId) onNavigate(sessionId, returnContext);
            } catch {
              startSessionFailed();
            } finally {
              resolveCurrentFlow();
            }
          })();
          return;
        }

        resetPickerState({
          pendingWorld: world,
          onNavigate,
          onSessionCreated: onSessionCreated ?? null,
          returnContext,
        });

        // Kick off the context-requirement lookup in parallel with the
        // variants fetch; refresh credits so the plan cap is current.
        fetchCreditsForChat();
        const requirementPromise = fetchContextRequirement(world.id);

        // Open the picker once the gate decides. If the card needs more
        // context than the user's effective setting, show the warning first;
        // any lookup failure opens the picker directly (fail-open).
        const openAfterGate = (variants: LanguageVariant[]) => {
          requirementPromise.then((requirement) => {
            const current = usePlaySessionPickerStore.getState();
            // Flow was closed or superseded while we were fetching
            if (current.pendingWorld?.id !== world.id) return;
            const { effective, planCap } = getEffectiveContextInfo();
            if (requirement && requirement.requiredTokens > effective) {
              usePlaySessionPickerStore.setState({
                variants,
                contextGate: { requirement, effective, planCap },
              });
            } else {
              usePlaySessionPickerStore.setState({ variants, open: true });
            }
          });
        };

        if (world.languageGroupId) {
          const controller = new AbortController();
          variantsAbortController = controller;

          fetch(`${apiBase}/api/worlds/${world.id}/language-variants`, {
            credentials: "include",
            signal: controller.signal,
          })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (controller.signal.aborted) return;
              openAfterGate(data?.data?.length > 1 ? data.data : []);
            })
            .catch((err) => {
              if (err instanceof DOMException && err.name === "AbortError") return;
              openAfterGate([]);
            });
          return;
        }

        openAfterGate([]);
      });
    },
    [historyInteraction, historySource, loading, onNavigate, onSessionCreated, resolveFlowForHook]
  );

  return { handlePlay, loading };
}
