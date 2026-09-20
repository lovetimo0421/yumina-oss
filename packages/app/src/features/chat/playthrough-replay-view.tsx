import { useState, useEffect, useMemo, useRef, useCallback, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Heart, Eye, Trash2 } from "lucide-react";
import { feedback } from "@/lib/feedback";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { navigateToStoryReturn, type StoryReturnContext } from "@/lib/story-return";
import { useSession } from "@/lib/auth-client";
import { WorldRenderer } from "./world-renderer";
import { makeVariableKeyResolver } from "./variable-key";
import type { YuminaAPI } from "@/features/studio/lib/custom-component-renderer";
import {
  GameStateManager,
  ReactionEvaluator,
  applySystemEffects,
  buildActionFiredEvent,
  processSystemEffects,
} from "@yumina/engine";
import type { WorldDefinition, AudioTrack } from "@yumina/engine";
import { safeParseWorldDef } from "@/lib/utils";
import { absoluteImageUrl, resolveImageUrl } from "@/lib/asset-url";
import { useUiStore } from "@/stores/ui";
import { useAudioStore } from "@/stores/audio";
import {
  getPlaythrough,
  togglePlaythroughLike,
  deletePlaythrough,
  type PlaythroughDetail,
} from "@/lib/playthroughs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { navigateBackSafely } from "@/lib/safe-back";

const apiBase = import.meta.env.VITE_API_URL || "";

// Replays are fully read-only — no LLM, no persistence, no session APIs.
const REPLAY_CAPABILITIES = {
  canSendMessage: false,
  canPersistSession: false,
  canUseSessionApis: false,
  requiresAuth: false,
} as const;

type VariableValue = number | string | boolean | Record<string, unknown> | unknown[];
type Variables = Record<string, VariableValue>;

export function PlaythroughReplayView({ playthroughId, returnContext }: { playthroughId: string; returnContext: StoryReturnContext }) {
  const { t } = useTranslation(["chat", "common"]);
  const router = useRouter();
  const handleBack = () => {
    if (returnContext.returnTo) navigateToStoryReturn(router.history, returnContext);
    else navigateBackSafely(router.history, "/app/library");
  };
  const { requireAuth } = useAuthGuard();
  const { data: session } = useSession();
  const playZoomPercent = useUiStore((s) => s.playZoomPercent);

  const [pt, setPt] = useState<PlaythroughDetail | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const [worldCover, setWorldCover] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);

  // ── Fetch playthrough snapshot + the card's schema ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const detail = await getPlaythrough(playthroughId);
        if (cancelled) return;
        setPt(detail);
        setLiked(detail.liked);
        setLikeCount(detail.likeCount);
        // The schema is fetched from the public world endpoint (same source the
        // guest preview uses) so we render against the card's current UI.
        const res = await fetch(`${apiBase}/api/worlds/${detail.worldId}`, { credentials: "include" });
        if (cancelled) return;
        if (res.ok) {
          const { data } = await res.json();
          setSchema(data?.schema ?? null);
          setWorldCover(absoluteImageUrl(data?.thumbnailUrl as string | null | undefined));
        }
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [playthroughId]);

  const worldDef = useMemo<WorldDefinition | undefined>(
    () => safeParseWorldDef(schema ?? undefined),
    [schema],
  );

  // Local game state, seeded from the snapshot's final state (NOT fresh
  // defaults — the whole point is to replay the world as it was). Custom UIs
  // poke setVariable/executeAction during mount; we apply those locally so the
  // scene renders, exactly like the guest preview does.
  const [variables, setVariables] = useState<Variables>({});
  useEffect(() => {
    if (!worldDef) return;
    // Overlay the snapshot's values on top of the CURRENT card defaults, so
    // variables the author added/renamed since this was shared still resolve
    // (parallels the continue path's normalizeGameState). Rendering the new UI
    // against raw old state would leave new vars undefined → NaN bars / blanks.
    const defaults = new GameStateManager(worldDef).getSnapshot().variables as Variables;
    const finalVars = ((pt?.finalState as { variables?: Variables } | undefined)?.variables) ?? {};
    setVariables({ ...defaults, ...finalVars });
  }, [pt?.finalState, worldDef]);

  // Load audio tracks so card audio APIs resolve during replay. We don't
  // auto-start the playlist — replays are for browsing, not ambience blasting.
  useEffect(() => {
    if (!worldDef) return;
    const audioStore = useAudioStore.getState();
    audioStore.cleanup();
    const tracks = worldDef.audioTracks;
    if (tracks && Array.isArray(tracks) && tracks.length > 0) {
      audioStore.setTracks(tracks as AudioTrack[]);
    }
    return () => {
      useAudioStore.getState().cleanup();
    };
  }, [worldDef]);

  // The snapshot messages drive the chat bubbles. Stamp synthetic ids/sessionId
  // (the snapshot dropped row ids) so customUI keyed lists stay stable.
  const replayMessages = useMemo<Array<Record<string, unknown>>>(() => {
    const list = (pt?.messages ?? []) as Array<Record<string, unknown>>;
    return list.map((m, i) => ({
      id: (m.id as string) ?? `replay_${i}`,
      sessionId: "",
      ...m,
    }));
  }, [pt?.messages]);

  const variablesRef = useRef<Variables>(variables);
  variablesRef.current = variables;

  // id-else-display-name, same as the session path (see ./variable-key.ts).
  const resolveVariableKey = useMemo(
    () => makeVariableKeyResolver(worldDef?.variables),
    [worldDef?.variables],
  );
  const handleSetVariable = useCallback<YuminaAPI["setVariable"]>((rawId, value) => {
    const id = resolveVariableKey(rawId);
    setVariables((prev) => (prev[id] === value ? prev : { ...prev, [id]: value as VariableValue }));
  }, [resolveVariableKey]);

  const handleExecuteAction = useCallback(
    (actionId: string) => {
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
          baseState as never,
        );
        const sysResult = processSystemEffects(result.effects);
        if (sysResult.variableEffects.length === 0 && sysResult.audioEffects.length === 0) return;
        const gsm = new GameStateManager(worldDef, baseState as never);
        applySystemEffects(gsm, sysResult);
        setVariables(gsm.getSnapshot().variables as Variables);
        if (sysResult.audioEffects.length > 0) {
          useAudioStore.getState().processAudioEffects(sysResult.audioEffects);
        }
      } catch {
        /* never crash the replay on a single broken action */
      }
    },
    [worldDef],
  );

  const replayAPI = useMemo<YuminaAPI>(
    () => ({
      // A blocked action is explained beside the control, not in a pill: the
      // header carries a permanent "Read-only" badge, and `readOnly: true`
      // below tells the card's own UI to disable its composer.
      sendMessage: () => {},
      setVariable: handleSetVariable,
      executeAction: handleExecuteAction,
      switchGreeting: () => {},
      mode: "guest-preview",
      capabilities: REPLAY_CAPABILITIES,
      variables,
      globalVariables: variables,
      worldName: worldDef?.name ?? "",
      worldCover,
      currentUser: null,
      messages: replayMessages,
      isStreaming: false,
      streamingContent: "",
      readOnly: true,
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
    [variables, replayMessages, worldDef?.name, worldCover, handleSetVariable, handleExecuteAction],
  );

  const playZoomStyle = useMemo(
    () => ({ "--play-ui-scale": `${playZoomPercent / 100}` }) as CSSProperties,
    [playZoomPercent],
  );

  const handleDelete = async () => {
    if (!pt) return;
    // No confirm — this only un-shares the snapshot, not the user's own chat.
    setDeleting(true);
    try {
      await deletePlaythrough(pt.id);
      // No pill: we go back to where we came from and the playthrough is gone
      // from that list — the absence is the confirmation.
      handleBack();
    } catch {
      setDeleting(false);
      feedback.error(t("replay.deleteFailed"), {
        label: t("common:action.retry"),
        onClick: () => void handleDelete(),
      });
    }
  };

  const handleLike = async () => {
    if (!pt) return;
    if (!requireAuth("like playthroughs")) return;
    // Optimistic
    setLiked((v) => !v);
    setLikeCount((c) => (liked ? Math.max(0, c - 1) : c + 1));
    try {
      const { liked: nowLiked, likeCount: nowCount } = await togglePlaythroughLike(pt.id);
      // Reconcile both from the server's authoritative values.
      setLiked(nowLiked);
      setLikeCount(nowCount);
    } catch {
      // revert the optimistic delta
      setLiked((v) => !v);
      setLikeCount((c) => (liked ? c + 1 : Math.max(0, c - 1)));
    }
  };

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  if (notFound || !pt) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground/50">{t("replay.notFound")}</p>
        <button
          onClick={handleBack}
          className="text-sm text-primary hover:underline"
        >
          {t("action.back", { ns: "common" })}
        </button>
      </div>
    );
  }

  const rootComponent = worldDef?.rootComponent;
  // The viewer can delete only their own share. Backend re-checks ownership.
  const isOwner = !!session?.user && pt.sharer.id === session.user.id;

  const header = (
    <div className="play-header-shell relative shrink-0 border-b border-white/[0.06]">
      {/* faint gold baseline — signals a curated replay, not just chrome */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
      <div className="play-header-inner play-replay-header px-3 py-2">
        <div className="play-replay-header-leading">
          <button
            onClick={handleBack}
            className="play-header-icon-button hover-surface shrink-0 rounded-md text-muted-foreground"
            aria-label={t("replay.back")}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <Avatar className="h-7 w-7 shrink-0 border border-white/10">
            <AvatarImage src={pt.sharer.image ? resolveImageUrl(pt.sharer.image) : undefined} />
            <AvatarFallback className="bg-primary/20 text-[10px] text-primary">
              {(pt.sharer.name ?? "?").charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[0.9rem] font-semibold text-foreground">{pt.title}</h2>
              <span className="hidden shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/[0.08] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-primary/80 sm:inline-flex">
                <Eye className="h-2.5 w-2.5" />
                {t("replay.readOnlyBadge")}
              </span>
            </div>
            <p className="truncate text-[11px] text-muted-foreground/50">
              {t("replay.byline", { name: pt.sharer.name })} · {t("replay.turns", { count: pt.messageCount })}
            </p>
          </div>
        </div>

        <div className="play-replay-header-actions">
          {isOwner && (
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="flex shrink-0 items-center justify-center rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
              aria-label={t("replay.delete")}
              title={t("replay.delete")}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          )}

          <button
            onClick={() => void handleLike()}
            className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors ${
              liked ? "text-red-400" : "text-muted-foreground hover:text-foreground"
            }`}
            aria-label={t("replay.like")}
          >
            <Heart className={`h-4 w-4 ${liked ? "fill-current" : ""}`} />
            {likeCount > 0 && <span className="text-xs">{likeCount}</span>}
          </button>

        </div>
      </div>
    </div>
  );

  if (!worldDef || !rootComponent) {
    return (
      <div className="play-page-root flex h-full w-full flex-col overflow-hidden" style={playZoomStyle}>
        {header}
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          {t("replay.cardUnavailable")}
        </div>
      </div>
    );
  }

  return (
    <div className="play-page-root flex h-full w-full flex-col overflow-hidden" style={playZoomStyle}>
      {header}
      <WorldRenderer
        entryFile={rootComponent.entryFile}
        files={rootComponent.files}
        variables={variables}
        variableDefs={worldDef?.variables ?? []}
        api={replayAPI}
        sessionId=""
        worldId={pt.worldId}
        mode="guest-preview"
        capabilities={REPLAY_CAPABILITIES}
        className="flex-1 min-h-0"
        entries={worldDef?.entries ?? []}
        loreUiBindings={worldDef?.loreUiBindings ?? []}
        worldbooks={worldDef?.worldbooks ?? []}
      />
    </div>
  );
}
