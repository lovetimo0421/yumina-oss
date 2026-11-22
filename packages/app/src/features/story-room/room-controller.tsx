import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import { kimiRepetitionOverride } from "@/lib/kimi-repetition";
import { useChatStore } from "@/stores/chat";
import { useConfigStore } from "@/stores/config";
import { storyRoomApi, type SendProfile } from "./api";
import { mirrorRoomEvent, roomStatePatch, storyRoomSetting, type MirrorState } from "./room-logic";
import { roomRequestIsPublic, takeRoomRequest, useRoomStore } from "./room-store";
import { openStoryRoomInvite } from "./invite-sheet-store";
import { useRoomChannel } from "./use-room-channel";

/**
 * Ties the open chat to its story room. Attaches the room the session load
 * reported (`storyRoomCode`, host or member), drops it when the chat changes,
 * and opens one when the card page asked for "play with friends".
 */
export function useRoomAttach(sessionId: string, isActive: boolean) {
  const session = useChatStore((s) => (s.session?.id === sessionId ? s.session : null));
  const code = (session as { storyRoomCode?: unknown } | null)?.storyRoomCode;
  const loadedId = session?.id ?? null;

  useEffect(() => {
    const { room, detach } = useRoomStore.getState();
    if (room && room.sessionId !== sessionId) detach();
  }, [sessionId]);

  useEffect(() => {
    if (!loadedId || !isActive) return;
    const wantsPublic = roomRequestIsPublic();
    const wantsRoom = takeRoomRequest();
    if (typeof code === "string" && code) {
      void useRoomStore.getState().attachByCode(code, loadedId).then(() => {
        const { room, role } = useRoomStore.getState();
        if (wantsRoom && room?.sessionId === loadedId && role === "host") openStoryRoomInvite(room);
      });
      return;
    }
    const s = useChatStore.getState();
    const owner = !s.readOnly && s.session?.userId === s.session?.currentUser?.id;
    if (wantsRoom && owner && storyRoomSetting(s.session?.world ?? null)) {
      void useRoomStore.getState().openForSession(loadedId, { invite: true, public: wantsPublic });
    }
  }, [loadedId, code, isActive]);
}

/** The signed-in player, as the chat knows them. */
function selfId(): string | null {
  const session = useChatStore.getState().session as { currentUser?: { id?: unknown } } | null;
  return typeof session?.currentUser?.id === "string" ? session.currentUser.id : null;
}

/** The model and settings the host would send a solo turn with, for the server to run rounds with. */
export function buildSendProfile(): SendProfile {
  const config = useConfigStore.getState();
  const pool = config.mixMode && config.modelPool.length > 1
    ? config.modelPool.map((e) => ({ model: e.modelId, weight: e.weight }))
    : null;
  const model = config.selectedModel;
  const liveScene = useChatStore.getState().liveScene;
  return {
    model,
    pool,
    overrides: {
      maxTokens: config.maxTokens,
      maxContext: config.maxContext,
      storyMemory: config.storyMemory ?? undefined,
      recapShare: config.recapShare ?? undefined,
      temperature: config.temperature,
      topP: config.topP,
      frequencyPenalty: config.frequencyPenalty,
      presencePenalty: config.presencePenalty,
      topK: config.topK,
      minP: config.minP,
      reasoningEffort: config.reasoningEffort,
      streaming: config.streaming,
      ...kimiRepetitionOverride(model, config.repetitionPenalty),
    },
    ...(liveScene ? { scene: liveScene } : {}),
  };
}

const PROFILE_DEBOUNCE_MS = 1_000;

/**
 * The host tells the server which model and settings run the rounds: on
 * attach, whenever the server says it has none, and after any change to the
 * model, the mix pool, the generation settings or the card's live scene.
 */
function useHostProfileSync(code: string | null, isHost: boolean, profileSet: boolean | undefined) {
  const sentRef = useRef<string | null>(null);
  useEffect(() => {
    sentRef.current = null;
  }, [code]);
  useEffect(() => {
    if (!code || !isHost) return;
    let timer: number | undefined;
    const push = (force = false) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const profile = buildSendProfile();
        const key = JSON.stringify(profile);
        if (!force && key === sentRef.current) return;
        sentRef.current = key;
        storyRoomApi.setProfile(code, profile).catch(() => {
          sentRef.current = null;
        });
      }, PROFILE_DEBOUNCE_MS);
    };
    push(profileSet === false);
    const offConfig = useConfigStore.subscribe(() => push());
    const offChat = useChatStore.subscribe((s, prev) => {
      if (s.liveScene !== prev.liveScene) push();
    });
    return () => {
      window.clearTimeout(timer);
      offConfig();
      offChat();
    };
  }, [code, isHost, profileSet]);
}

/**
 * The room's live channel while its chat is open. The server sends every
 * round to the AI as the host (the host's model, key and wallet, as in a solo
 * turn), so the host's browser can close and the story goes on. Everyone,
 * host included, keeps the room snapshot current and mirrors the round into
 * the chat as it streams; the room closing or a kick detaches it.
 */
export function RoomController({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("common");
  const room = useRoomStore((s) => s.room);
  const role = useRoomStore((s) => s.role);
  const code = room && room.sessionId === sessionId && room.status === "open" ? room.code : null;
  const isHost = role === "host";

  // The host's own streams (regenerate, continue) arrive on the host's own
  // request too; only a round the server runs is mirrored for the host.
  const roundRef = useRef<string | null>(null);

  const onEvent = (name: string, data: unknown) => {
    const { role: currentRole } = useRoomStore.getState();
    if (!currentRole) return;
    const chat = useChatStore.getState();
    if (chat.session?.id !== sessionId) return;
    // Someone else's press on the card's screen moved the shared game: every
    // screen, the host's included, shows the variables as they now stand.
    if (name === "state") {
      const patch = roomStatePatch(chat, data, selfId());
      if (patch) useChatStore.setState(patch as never);
      return;
    }
    if (currentRole === "host") {
      if (name === "turn-start") {
        const turnId = (data as { turnId?: unknown } | null)?.turnId;
        roundRef.current = typeof turnId === "string" ? turnId : "turn";
      } else if (!roundRef.current) {
        return;
      }
    }
    const result = mirrorRoomEvent(chat as unknown as MirrorState, name, data, sessionId);
    if (name === "turn-done") roundRef.current = null;
    if (!result) return;
    useChatStore.setState(result.patch as never);
    if (result.refresh) {
      void chat.refreshMessages().finally(() => {
        useChatStore.setState({ isStreaming: false, streamingContent: "", streamingReasoning: "" });
      });
    }
  };
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const { view } = useRoomChannel(code, {
    trackStream: true,
    onEvent: (name, data) => onEventRef.current(name, data),
  });
  const snap = view.snapshot;

  useEffect(() => {
    if (snap && code && snap.room.code === code) useRoomStore.getState().setSnapshot(snap);
  }, [snap, code]);

  useEffect(() => {
    if (!code || (!view.closed && !view.kicked)) return;
    const wasMember = useRoomStore.getState().role === "player";
    useRoomStore.getState().detach();
    roundRef.current = null;
    if (wasMember) {
      feedback.notice(t(view.kicked ? "storyRoom.errKicked" : view.closedReason === "host-left" ? "storyRoom.errHostLeft" : "storyRoom.errClosed"));
      useChatStore.setState({ isStreaming: false, streamingContent: "", streamingReasoning: "" });
    }
  }, [code, view.closed, view.kicked, view.closedReason, t]);

  useHostProfileSync(code, isHost, snap?.room.code === code ? snap?.profileSet : undefined);

  // A member who arrives mid-story reads 前情提要 first, once per room.
  // Only once there is more behind them than the last reply they can already see.
  const recapReady = !!snap && snap.room.code === code && !isHost && !!snap.recap && (!!snap.recap.summary || snap.recap.turns >= 3);
  const roomId = snap?.room.id ?? null;
  useEffect(() => {
    if (!recapReady || !roomId) return;
    const key = `yumina:room-recap:${roomId}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      /* storage blocked: show it anyway */
    }
    useRoomStore.getState().setRecapOpen(true);
  }, [recapReady, roomId]);

  return null;
}
