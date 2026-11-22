import { readChatImages, pastedImageFiles, chatImageCopy } from "../../src/lib/chat-image-input";
import { formatModelId, PLAY_MODELS, type ChatImageInput } from "@yumina/shared";
import { useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import {
  Send,
  ImagePlus,
  Square,
  Plus,
  X,
  RotateCcw,
  FastForward,
  User,
  Share2,
  Users,
  GitBranch,
  ArrowUp,
  ListTree,
  Loader2,
  Check,
  Image as ImageIcon,
  ScrollText,
  Brain,
  Search,
  Clapperboard,
  Palette,
  Sparkles,
  Undo2,
  RefreshCw,
  ChevronDown,
  MessageSquareDashed,
} from "lucide-react";
import {
  currentVideoState,
  useYumina,
  COMPOSER_DRAFT_EVENT,
  OPEN_MEMORY_PANEL_EVENT,
  OPEN_CHAT_SEARCH_EVENT,
  type BranchContext,
  type BranchNode,
} from "../sandbox-context";
import { ModelTrigger } from "./model-picker-modal";
import { ThinkingControl } from "./thinking-control";
import { VoicePanelButton } from "./voice-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useReadingAppearance } from "./reading-appearance";
import { ComposerPopover } from "./composer-popover";
import { useComposerGuard } from "./composer-guard";
import { MicButton, VoiceRecordingOverlay, useHoldToTalkKey, useVoiceInput } from "./voice-input";
import { makeChatT } from "./i18n";
import { restoreTurnNote, settleTurnNote, useNoteDraft } from "./player-note-draft";
import { useTurnImageSettings } from "./turn-images";
import { SlotOutlet, useToolMenuCount } from "../extensions/registry";
import { ComposerToolMenu, useIsNarrow } from "./composer-tool-menu";
import { PromptsQuickSheet, openPromptsPanel, usePromptsAvailable, usePromptsStatus } from "./player-prompts";
import { postToParentWindow, wrapMessage } from "../protocol";
import { RoomMemberComposer, RoomModeChips, RoundStrip, ROOM_MODE_OFF, TalkFeed, postToRoom, signalRoomTyping, useRoomComposerPresence, type RoomMode } from "./story-room";
import {
  clampComposerMessage,
  getComposerMessageLimitState,
  MAX_USER_MESSAGE_CHARS,
} from "../../src/lib/composer-message-limit";

const buttonColorLabels = {
  default: "buttonColorDefault",
  lighter: "buttonColorLighter",
  darker: "buttonColorDarker",
} as const;

// How long to sit on keystrokes before mirroring the draft to the host. Long
// enough that a fast typist doesn't generate a postMessage per character, short
// enough that a reload arriving mid-sentence still finds the text.
const COMPOSER_DRAFT_SYNC_MS = 400;

export function MessageInput() {
  const api = useYumina();
  useRoomComposerPresence();
  const appearance = useReadingAppearance();
  const {
    isStreaming,
    pendingChoices,
    readOnly,
    sendMessage,
    stopGeneration,
    continueLastMessage,
    restartChat,
    clearPendingChoices,
    openPersonaManager,
    openModelPicker: openSharedModelPicker,
    openSessionManager,
    sharePlaythrough,
    messages,
    getBranchContext,
    branchFromMessage,
    navigate,
  } = api;
  const openModelPicker = () => openSharedModelPicker();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const generationBlocked = isStreaming || !!api.modelFallback;
  // In a story room: how the next line joins it (players-only talk / keep the AI waiting).
  const [roomMode, setRoomMode] = useState<RoomMode>(ROOM_MODE_OFF);
  const canSendMessage = api.capabilities?.canSendMessage !== false
    && api.mode !== "guest-preview";

  const [content, setContent] = useState("");
  // 给 AI 的话: null = closed; rides on the next turn as a one-turn direction.
  // Shared with the sandbox API (player-note-draft.ts), which attaches it to
  // whatever sends that turn: this box, a choice, voice, continue, regenerate.
  const [note, setNote] = useNoteDraft();
  const noteInputRef = useRef<HTMLInputElement>(null);
  const noteText = note?.trim() ?? "";
  // 帮我写: the box text before the AI wrote, so 撤销 can put it back.
  const [assist, setAssist] = useState<{ original: string; writing: boolean } | null>(null);
  const assistRunRef = useRef(0);
  const assistAllowed = api.composeAssistAllowed;
  const [images, setImages] = useState<ChatImageInput[]>([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const [imageError, setImageError] = useState<string | null>(null);
  const [readingImages, setReadingImages] = useState(false);
  const readingRef = useRef(false);
  const lastImagesRef = useRef<ChatImageInput[]>([]);
  const [modelImages, setModelImages] = useState<Record<string, boolean | undefined>>({});
  const imageText = (key: string) => chatImageCopy(api.language, key);
  useEffect(() => {
    let active = true;
    setModelImages({});
    api.getModels().then(data => { if (active) setModelImages(Object.fromEntries(data.models.map(m => [m.id, m.supportsImages]))); }).catch(() => {});
    return () => { active = false; };
  }, [api.preferredProvider, api.selectedModel]);
  const candidates = api.mixMode && api.modelPool.length > 1 ? api.modelPool.map(m => m.modelId) : [api.selectedModel];
  const incompatibleImages = images.length > 0 && candidates.some(id =>
    (modelImages[id] ?? (api.preferredProvider === "official" ? PLAY_MODELS.find(m => m.id === id)?.supportsImages : undefined)) === false);
  const addImages = async (files: File[]) => {
    if (!files.length || readingRef.current) return;
    readingRef.current = true;
    setReadingImages(true);
    setImageError(null);
    try {
      const added = await readChatImages(files, imagesRef.current);
      setImages(current => [...current, ...added]);
    } catch (error) { setImageError(error instanceof Error ? error.message : "read"); }
    finally { readingRef.current = false; setReadingImages(false); }
  };
  const pickImage = async () => {
    if (readingRef.current) return;
    readingRef.current = true;
    setReadingImages(true);
    setImageError(null);
    try {
      const image = await api.pickChatImage();
      if (image) {
        // Keep the existing four-image and total-byte limits for library images.
        await readChatImages([], [...imagesRef.current, image]);
        setImages(current => [...current, image]);
      }
    } catch (error) { setImageError(error instanceof Error ? error.message : "read"); }
    finally { readingRef.current = false; setReadingImages(false); }
  };
  const messageLimitState = getComposerMessageLimitState(content);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const { settings: turnImages, setAuto: setAutoTurnImages, setStyle: setTurnImageStyle, refresh: refreshTurnImages } = useTurnImageSettings(api);
  useEffect(() => { if (actionsOpen) refreshTurnImages(); }, [actionsOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  // Scene video (experimental): offered here once the player turned it on in Settings.
  const [filmOn, setFilmOn] = useState(() => { const s = currentVideoState(); return !!(s?.offered && s.optedIn); });
  useEffect(() => api.realtimeVideo.onEvent((e) => { if (e.type === "state") setFilmOn(!!(e.state.offered && e.state.optedIn)); }), [api]);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchCtx, setBranchCtx] = useState<BranchContext | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState(false);
  const [branching, setBranching] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Tracks an in-flight IME composition so Enter commits the candidate instead
  // of sending. (The sandbox is bundled in isolation and can't import the app's
  // shared composer-submit hook, so the guard is inlined here.)
  const composingRef = useRef(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const colorMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLDivElement>(null);
  // On a narrow toolbar (mobile / split desktop) collapse the model pill and
  // the extension buttons into one menu so they don't crowd the send button.
  // Only when there IS a launchable tool to collapse — otherwise keep the plain
  // inline model pill.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useComposerGuard(cardRef, textareaRef, !readOnly && canSendMessage);
  const isNarrow = useIsNarrow(toolbarRef, 520);
  const toolMenuCount = useToolMenuCount();
  // 「发送图片」 and 「提示词」 live in the "+" menu, so the toolbar is just
  // [+] [model pill + balance] … [voice] [mic/send] at every width.
  const promptsAvailable = usePromptsAvailable();
  const promptsStatus = usePromptsStatus();
  // A prompt auto-applies on this model: gold dot on "+" (and on the menu row)
  // so it stays visible with the menu closed.
  const promptBound = promptsAvailable && !!api.playerPrompts?.boundPromptName;
  const collapseTools = isNarrow && toolMenuCount > 0;
  // Small phones / narrow custom-UI columns (<400px): the mushie balance
  // NEVER hides (it once did, and players read it as "my balance is gone").
  // It switches to its short form and the model name truncates instead.
  const isTight = useIsNarrow(toolbarRef, 400);
  // Stash of the text we just sent, so a failed send can restore it to the
  // composer (creator feedback 2026-05-31: "don't swallow my message").
  const lastSentRef = useRef<string | null>(null);
  const prevErrorRef = useRef(api.error);

  // ── Click-outside handler for dropdowns ────────────────────────────
  useEffect(() => {
    if (!actionsOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!actionsRef.current?.contains(target) && !actionsMenuRef.current?.contains(target) && !colorMenuRef.current?.contains(target)) {
        setActionsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [actionsOpen]);

  // ── Branch panel: click-outside + Esc dismissal ────────────────────
  useEffect(() => {
    if (!branchOpen) return;
    const onDown = (e: MouseEvent) => {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) {
        setBranchOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBranchOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [branchOpen]);

  // ── Branch panel: (re)load context every time it opens ─────────────
  const loadBranchCtx = useCallback(async () => {
    setBranchLoading(true);
    setBranchError(false);
    try {
      setBranchCtx(await getBranchContext());
    } catch {
      setBranchError(true);
    } finally {
      setBranchLoading(false);
    }
  }, [getBranchContext]);

  useEffect(() => {
    if (branchOpen) void loadBranchCtx();
  }, [branchOpen, loadBranchCtx]);

  // ── Handlers ───────────────────────────────────────────────────────

  const handleSend = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed && !images.length && !noteText) return;
    // A story room: the line joins the round (or the players' talk); the
    // server sends rounds, so writing ahead while the AI answers is fine.
    if (api.storyRoom) {
      if (!trimmed || assist?.writing) return;
      lastSentRef.current = null;
      setAssist(null);
      postToRoom(trimmed, roomMode);
      setContent("");
      return;
    }
    if (readingImages || incompatibleImages) return;
    if (generationBlocked || assist?.writing) return;
    setAssist(null);
    // The open note goes along on its own (sandbox API, player-note-draft.ts);
    // an empty one closes with the send, as it always did.
    if (!noteText) setNote(null);
    if (!trimmed && !images.length) {
      // A note with no message: the AI goes on, following it.
      continueLastMessage();
      return;
    }
    lastSentRef.current = trimmed;
    lastImagesRef.current = images;
    sendMessage(trimmed, images);
    setImages([]);
    setContent("");
    // Height resets itself: the CSS auto-grow wrapper shrinks to one line once
    // `content` is empty (no manual style write, so no forced reflow).
  }, [content, images, noteText, assist, readingImages, incompatibleImages, generationBlocked, sendMessage, continueLastMessage, api.storyRoom, roomMode]);

  // ── 帮我写 ─────────────────────────────────────────────────────────
  // Streams into the box; nothing is sent. 重写 starts again from the same
  // original, 撤销 (or stopping mid-way) puts the original back.
  const runAssist = useCallback(async () => {
    if (!assistAllowed || assist?.writing || isStreaming) return;
    const original = assist ? assist.original : content;
    const run = ++assistRunRef.current;
    setAssist({ original, writing: true });
    try {
      const text = await api.composeAssist({
        text: original.trim() || undefined,
        onDelta: (soFar) => { if (assistRunRef.current === run) setContent(clampComposerMessage(soFar)); },
      });
      if (assistRunRef.current !== run) return;
      if (!text.trim()) throw new Error("empty");
      setContent(clampComposerMessage(text));
      setAssist({ original, writing: false });
    } catch {
      if (assistRunRef.current !== run) return;
      setContent(original);
      setAssist(null);
      api.showToast(t("assistFailed"), "error");
    }
  }, [assistAllowed, assist, isStreaming, content, api, t]);

  const undoAssist = useCallback(() => {
    if (!assist) return;
    assistRunRef.current++;
    setContent(assist.original);
    setAssist(null);
  }, [assist]);

  const composeModelName = useMemo(() => {
    const id = api.composeModel;
    return PLAY_MODELS.find((m) => m.id === id)?.name ?? (id ? formatModelId(id) : "");
  }, [api.composeModel]);

  // ── Voice input (hold-to-talk) ─────────────────────────────────────
  const voiceInput = api.voiceInputState;
  const voiceReady = voiceInput.available && voiceInput.enabled && canSendMessage && !readOnly;
  const contentRef = useRef(content);
  contentRef.current = content;
  const handleTranscript = useCallback((text: string) => {
    const current = contentRef.current;
    // "Send as spoken" only when nothing else is waiting in the box; words
    // spoken on top of a half-typed message join it instead.
    if (voiceInput.mode === "auto" && !current.trim() && !imagesRef.current.length && !generationBlocked) {
      lastSentRef.current = text;
      lastImagesRef.current = [];
      sendMessage(text);
      return;
    }
    setContent(clampComposerMessage(current.trim() ? `${current.trimEnd()} ${text}` : text));
    // Desktop: caret at the end, ready to edit. Phones: leave the keyboard shut.
    const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    if (!touch) {
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        const end = el.value.length;
        try { el.setSelectionRange(end, end); } catch { /* noop */ }
      });
    }
  }, [voiceInput.mode, generationBlocked, sendMessage]);
  const voice = useVoiceInput(handleTranscript);
  useHoldToTalkKey(voiceInput.key, voiceReady && !isStreaming, voice);
  const showMic = voiceReady && !content.trim() && !images.length && !noteText;

  const handleChoiceClick = useCallback(
    (choice: string) => {
      if (generationBlocked) return;
      lastSentRef.current = choice;
      lastImagesRef.current = [];
      sendMessage(choice);
      setContent("");
    },
    [generationBlocked, sendMessage]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    // Never send while a pinyin/CJK candidate is being composed — Enter commits it.
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Match Settings and the host composer: touch support alone also includes laptops.
    const isTouchPrimary = typeof window.matchMedia === "function"
      && window.matchMedia("(pointer: coarse)").matches;
    if (isTouchPrimary) return; // touch keyboards: Enter = newline, send via the button
    // Honor the user's Settings → "Press Enter to send" preference (mirrored
    // across the bridge — the iframe can't read the host ui store). Same
    // semantics as the host's useComposerSubmit:
    //   "enter"     → Enter sends, Shift+Enter newlines.
    //   "mod-enter" → Ctrl/⌘+Enter sends, plain Enter newlines.
    if (api.composerSendKey === "mod-enter") {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleSend();
      }
      return;
    }
    if (!e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleRestart = useCallback(async () => {
    setConfirmRestart(false);
    restartChat();
  }, [restartChat]);

  const handleContinue = useCallback(() => {
    if (generationBlocked) return;
    continueLastMessage();
    setActionsOpen(false);
  }, [generationBlocked, continueLastMessage]);

  const handleOpenPersona = useCallback(() => {
    setActionsOpen(false);
    openPersonaManager();
  }, [openPersonaManager]);

  const handleSharePlaythrough = useCallback(() => {
    setActionsOpen(false);
    sharePlaythrough?.();
  }, [sharePlaythrough]);

  // Story room (host side): the parent opens the room panel over the chat.
  // A platform action, not part of the card API, so it is posted directly.
  const handlePlayWithFriends = useCallback(() => {
    setActionsOpen(false);
    postToParentWindow(wrapMessage({ type: "api-call" as const, callId: `fire-room-${Date.now()}`, method: "openStoryRoom", args: [] }));
  }, []);

  // ── Branch handlers ────────────────────────────────────────────────
  const canBranchFromLatest = !isStreaming && (messages?.length ?? 0) > 0;

  const handleOpenBranch = useCallback(() => {
    setActionsOpen(false);
    setBranchOpen(true);
  }, []);

  const goToBranch = useCallback(
    (id: string) => {
      setBranchOpen(false);
      navigate(`/app/chat/${id}`);
    },
    [navigate]
  );

  const handleBranchFromLatest = useCallback(async () => {
    if (!canBranchFromLatest || branching) return;
    const list = messages ?? [];
    const latest = list[list.length - 1] as { id?: string } | undefined;
    const latestId = latest?.id;
    if (!latestId) return;
    setBranching(true);
    try {
      // branchFromMessage surfaces its own success/error toast in the host.
      const newId = await branchFromMessage(latestId);
      if (newId) {
        setBranchOpen(false);
        navigate(`/app/chat/${newId}`);
      }
    } finally {
      setBranching(false);
    }
  }, [canBranchFromLatest, branching, messages, branchFromMessage, navigate]);

  const handleOpenManager = useCallback(() => {
    setBranchOpen(false);
    openSessionManager();
  }, [openSessionManager]);

  const timeAgo = useCallback(
    (iso: string) => {
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return t("timeJustNow");
      if (mins < 60) return t("timeMinAgo", { n: mins });
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return t("timeHourAgo", { n: hrs });
      return t("timeDayAgo", { n: Math.floor(hrs / 24) });
    },
    [t]
  );

  // ── Mirror the draft to the host ───────────────────────────────────
  // The host refuses the post-deploy auto-reload while this is non-empty, and
  // persists it so a reload it couldn't avoid (manual F5, stale-chunk recovery)
  // doesn't cost the user a half-typed message. The sandbox can't store this
  // itself: it runs on an opaque origin where sessionStorage throws.
  // Debounced while typing, but flushed synchronously the moment the composer
  // empties (send / clear) so the reload guard unblocks without a stale tail.
  const draftMirrorPrimedRef = useRef(false);
  useEffect(() => {
    const report = (text: string) =>
      postToParentWindow(wrapMessage({ type: "composer-draft" as const, text }));

    // Skip the mount-time empty report. The host may be holding a saved draft
    // it hasn't pushed down yet, and reporting "" would delete it before the
    // restore ever lands.
    if (!draftMirrorPrimedRef.current) {
      draftMirrorPrimedRef.current = true;
      if (!content) return;
    }

    if (!content) {
      report("");
      return;
    }
    const id = window.setTimeout(() => report(content), COMPOSER_DRAFT_SYNC_MS);
    return () => window.clearTimeout(id);
  }, [content]);

  // ── External prefill (yumina.setComposerDraft, host draft restore) ──
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string; focus?: boolean }>).detail;
      const text = detail?.text ?? "";
      setContent(clampComposerMessage(text));
      // Restoring a draft on load must not steal focus — that would pop the
      // mobile keyboard on every reload. Creator-driven prefill still focuses.
      if (detail?.focus === false) return;
      // Focus + move caret to end on the next frame so layout has settled
      // against the new value.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        // preventScroll: programmatic focus must never scroll #sandbox-root
        // (the document scroller) — a missed clamp would strand the canvas
        // offset. The OS keyboard reveal still works via viewport resize.
        el.focus({ preventScroll: true });
        const end = el.value.length;
        try { el.setSelectionRange(end, end); } catch { /* noop */ }
      });
    };
    window.addEventListener(COMPOSER_DRAFT_EVENT, handler);
    return () => window.removeEventListener(COMPOSER_DRAFT_EVENT, handler);
  }, []);

  // ── Auto-resize ─────────────────────────────────────────────────────
  // Handled by CSS, not JS. The textarea sits in a `.play-composer-grow`
  // grid whose hidden ::after replica mirrors `content` and sizes the cell.
  // The old JS version set style.height + read scrollHeight on every [content]
  // change — a synchronous forced reflow per keystroke. On long sessions that
  // reflow re-laid-out every message row (after content-visibility paint-
  // skipping was removed in c7f83e05), which froze the tab while typing.

  // ── Preserve the user's message on a failed send ───────────────────
  // The composer clears optimistically on send. If the send then fails (the
  // model errored, the stream dropped, or it returned an empty reply), put the
  // text back so a long message never has to be retyped. Only refill an empty
  // composer so we never clobber something new the user has started typing.
  useEffect(() => {
    const prev = prevErrorRef.current;
    prevErrorRef.current = api.error;
    if (api.error && api.error !== prev) restoreTurnNote();
    if (api.error && api.error !== prev && lastSentRef.current !== null) {
      const failed = lastSentRef.current;
      const failedImages = lastImagesRef.current;
      lastImagesRef.current = [];
      setImages(cur => cur.length ? cur : failedImages);
      lastSentRef.current = null;
      setContent((cur) => (cur.trim() ? cur : failed));
    }
  }, [api.error]);

  // Toast-only failures (NO_CREDITS, MODEL_NOT_ALLOWED, …) deliberately never
  // set `error`, so the effect above can't see them — the host bumps
  // sendFailureNonce for EVERY terminally-failed send instead (@burlingk lost a
  // long post to the plan-gate toast). Declared before the stash-drop effect so
  // that, when both fire in one commit, the restore consumes the stash first.
  const lastHandledNonceRef = useRef(api.sendFailureNonce);
  useEffect(() => {
    if (api.sendFailureNonce === lastHandledNonceRef.current) return;
    lastHandledNonceRef.current = api.sendFailureNonce;
    restoreTurnNote();
    if (lastSentRef.current !== null) {
      const failed = lastSentRef.current;
      const failedImages = lastImagesRef.current;
      lastImagesRef.current = [];
      setImages(cur => cur.length ? cur : failedImages);
      lastSentRef.current = null;
      setContent((cur) => (cur.trim() ? cur : failed));
    }
  }, [api.sendFailureNonce]);

  // Drop the stash once a send completes cleanly (no error) so a later,
  // unrelated failure can't resurrect an old message. Delayed: isStreaming
  // (streaming channel) and error/sendFailureNonce (ui channel) arrive as
  // separate bridge messages, so "streaming ended, no error yet" is also the
  // first frame of every failure — dropping synchronously here raced the
  // failure signal and ate the stash before the restore effects could run.
  useEffect(() => {
    if (isStreaming || api.error) return;
    const t = window.setTimeout(() => { lastSentRef.current = null; lastImagesRef.current = []; settleTurnNote(); }, 2000);
    return () => window.clearTimeout(t);
  }, [isStreaming, api.error]);

  // A story room member reads the host's chat; their composer posts to the round.
  if (readOnly && api.storyRoom && !api.storyRoom.isHost) return <RoomMemberComposer room={api.storyRoom} />;
  if (readOnly || !canSendMessage) return null;

  return (
    <div className="play-composer-shell shrink-0">
      <PromptsQuickSheet />
      <div className="play-composer-inner w-full min-w-0">
        {api.storyRoom && (
          <>
            <TalkFeed room={api.storyRoom} />
            <RoundStrip room={api.storyRoom} />
            <RoomModeChips mode={roomMode} onChange={setRoomMode} />
          </>
        )}
        {/* Choice buttons */}
        {pendingChoices.length > 0 && !isStreaming && (
          <div className="play-choice-row mb-2 flex flex-wrap items-center gap-1.5">
            {pendingChoices.map((choice, i) => (
              <button
                key={i}
                onClick={() => handleChoiceClick(choice)}
                className="play-choice-chip rounded-lg border border-border/50 bg-accent px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
              >
                {choice}
              </button>
            ))}
            <button
              onClick={clearPendingChoices}
              className="play-choice-dismiss flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/30 transition-colors hover:text-muted-foreground/60"
              title={t("dismissChoices")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Glass reply bar card.
            No `overflow-hidden`: the "+" actions menu opens upward (absolute
            bottom-full) and must escape the card bounds, or it gets clipped by
            the composer. The only child whose background reaches a rounded
            corner is the restart-confirm banner, which rounds its own top. */}
        <div ref={cardRef} className="play-composer-card glass relative rounded-2xl">
          <VoiceRecordingOverlay voice={voice} autoSend={voiceInput.mode === "auto" && !content.trim()} />
          {/* Restart confirmation banner */}
          {confirmRestart && (
            <div className="flex items-center justify-between rounded-t-2xl border-b border-border/50 bg-destructive/5 px-4 py-2">
              <span className="text-xs text-foreground/70">
                {t("restartBanner")}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleRestart}
                  className="rounded-md bg-destructive/15 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/25"
                >
                  {t("restart")}
                </button>
                <button
                  onClick={() => setConfirmRestart(false)}
                  className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          )}

          {images.length > 0 && <div className="flex flex-wrap gap-2 px-4 pt-3">
            {images.map((image, index) => <div key={index} className="relative">
              <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} className="h-16 w-16 rounded-lg border border-border object-cover" />
              <button type="button" aria-label={imageText("remove")} onClick={() => setImages(cur => cur.filter((_, i) => i !== index))}
                className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-popover text-foreground shadow"><X className="h-3 w-3" /></button>
            </div>)}
          </div>}
          {/* 给 AI 的话 */}
          {note !== null && (
            <div data-player-note-field="" className="play-composer-note mx-3 mt-2.5 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.07] py-1.5 pl-3 pr-1.5">
              <MessageSquareDashed className="h-4 w-4 shrink-0 text-primary/80" aria-hidden="true" />
              <input
                ref={noteInputRef}
                value={note}
                maxLength={500}
                aria-label={t("note")}
                placeholder={t("notePlaceholder")}
                onChange={(e) => setNote(e.target.value)}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; }}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && !noteText) { e.preventDefault(); setNote(null); return; }
                  if (e.key !== "Enter" || composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  textareaRef.current?.focus({ preventScroll: true });
                }}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setNote(null)}
                aria-label={t("noteRemove")}
                title={t("noteRemove")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {/* 帮我写: which model wrote it, and the way back. */}
          {assist && (
            <div data-compose-assist-strip="" className="play-composer-assist flex items-center gap-1 px-3 pt-2 text-xs text-muted-foreground">
              <Sparkles className={`h-3.5 w-3.5 shrink-0 text-primary ${assist.writing ? "animate-pulse" : ""}`} aria-hidden="true" />
              <span className="shrink-0 pl-0.5 text-foreground/70">{assist.writing ? t("assistWriting") : t("assist")}</span>
              <span aria-hidden="true" className="text-muted-foreground/40">·</span>
              <button
                type="button"
                onClick={() => api.openComposeModelPicker()}
                aria-label={t("assistModel")}
                title={t("assistModel")}
                className="flex min-w-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
              >
                <span className="truncate">{composeModelName}</span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
              </button>
              <span className="flex-1" />
              <button
                type="button"
                onClick={undoAssist}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
              >
                <Undo2 className="h-3.5 w-3.5" />
                {t("assistUndo")}
              </button>
              {!assist.writing && (
                <button
                  type="button"
                  onClick={() => void runAssist()}
                  disabled={isStreaming}
                  className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("assistRetry")}
                </button>
              )}
            </div>
          )}
          {(imageError || incompatibleImages) && <div role="status" className="px-4 pt-2 text-xs text-muted-foreground">
            {imageText(imageError ?? "unsupported")}
            {incompatibleImages && <button type="button" onClick={openModelPicker} className="ml-2 text-primary underline">{imageText("choose")}</button>}
          </div>}
          {/* Textarea — full width. The wrapper grows to a hidden text replica
              (data-replicated-value) so the textarea auto-sizes via CSS only —
              no per-keystroke scrollHeight read / forced reflow. Padding, font
              size and wrapping are set on both textarea and replica in CSS
              (.play-composer-grow) so they measure identically. */}
          <div className="play-composer-grow" data-replicated-value={content}>
            <textarea
              ref={textareaRef}
              id="yumina-composer-input"
              value={content}
              maxLength={MAX_USER_MESSAGE_CHARS}
              readOnly={!!assist?.writing}
              onChange={(e) => {
                const next = clampComposerMessage(e.target.value);
                setContent(next);
                // Cleared the box: nothing left to undo to.
                if (!next.trim() && assist && !assist.writing) setAssist(null);
                if (api.storyRoom && next.trim()) signalRoomTyping(roomMode);
              }}
              onKeyDown={handleKeyDown}
              onPaste={e => {
                const files = pastedImageFiles(e.clipboardData.items);
                if (!files.length) return;
                e.preventDefault();
                void addImages(files);
              }}
              onDrop={e => {
                // Dropped image files attach like a paste; dropped text keeps
                // the native insert.
                const files = pastedImageFiles(e.dataTransfer?.items ?? []);
                if (!files.length) return;
                e.preventDefault();
                void addImages(files);
              }}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              placeholder={
                api.storyRoom && roomMode.talk ? t("roomTalkPlaceholder")
                  : api.modelFallback ? modelFallbackText(api.language, "waiting") : isStreaming
                  ? t("generating")
                  : pendingChoices.length > 0
                    ? t("choiceHint")
                    : t("placeholder")
              }
              // NOT disabled while streaming: disabling forcibly blurs the
              // textarea, which slams the phone keyboard shut on every send
              // (and each close/open cycle is a viewport resize — the exact
              // churn behind the stale-canvas bugs). Typing ahead is fine;
              // handleSend/Enter are already guarded by isStreaming, and the
              // send button becomes Stop during generation.
              rows={1}
              className={`play-composer-textarea block w-full resize-none bg-transparent text-foreground placeholder:text-muted-foreground/75 focus:outline-none ${isStreaming ? "opacity-60" : ""}`}
            />
          </div>

          {/* Bottom row: + button (left) | send (right) */}
          <div ref={toolbarRef} className="play-composer-toolbar px-3 pb-2.5">
            {/* Left: actions menu + model trigger */}
            <div className="play-composer-actions flex items-center gap-1">
              <div ref={actionsRef} className="relative">
                <button
                  onClick={() => setActionsOpen((v) => !v)}
                  className="play-composer-icon-button hover-surface relative rounded-lg text-foreground/70 hover:text-foreground transition-colors"
                  title={t("actions")}
                  aria-expanded={actionsOpen}
                >
                  {readingImages ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {promptBound && (
                    <span data-prompt-bound-dot="" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full border border-background bg-primary" aria-hidden="true" />
                  )}
                </button>
                {actionsOpen && (
                  /* Row padding + icon size are em-based so Android textZoom
                     (which inflates text but not rem/px boxes) scales the whole
                     row with the text. ~45px rows at 16px type. */
                  <ComposerPopover
                    anchorRef={actionsRef}
                    popoverRef={actionsMenuRef}
                    align="left"
                    gap={4}
                    className="min-w-[230px] overflow-y-auto rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
                  >
                    {/* Composer inputs first: attach an image (paste / drop
                        into the textbox still work too) and the prompts panel. */}
                    <button
                      onClick={() => {
                        setActionsOpen(false);
                        void pickImage();
                      }}
                      disabled={readingImages}
                      className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent disabled:opacity-40"
                    >
                      <ImagePlus className="h-[1.15em] w-[1.15em]" />
                      {t("sendImage")}
                    </button>
                    {promptsAvailable && (
                      <button
                        onClick={() => {
                          setActionsOpen(false);
                          openPromptsPanel();
                        }}
                        className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                      >
                        <ScrollText className={`h-[1.15em] w-[1.15em] ${promptBound ? "text-primary" : ""}`} />
                        <span className="flex min-w-0 flex-1 flex-col text-left">
                          <span>{t("prompts")}</span>
                          {promptsStatus && (
                            <span className="max-w-[16rem] truncate text-xs text-muted-foreground">{promptsStatus}</span>
                          )}
                        </span>
                        {promptBound && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
                      </button>
                    )}
                    {/* 帮我写: empty box writes the player's next move; text gets expanded. */}
                    {assistAllowed && (
                      <button
                        data-compose-assist=""
                        onClick={() => {
                          setActionsOpen(false);
                          void runAssist();
                        }}
                        disabled={isStreaming || !!assist?.writing}
                        className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent disabled:opacity-40"
                      >
                        <Sparkles className={`h-[1.15em] w-[1.15em] ${assist ? "text-primary" : ""}`} />
                        {t("assist")}
                      </button>
                    )}
                    {/* 给 AI 的话: a one-turn direction, not story text. A story
                        room's round is put together by the server, so not there. */}
                    {api.sessionId && !api.storyRoom && (
                      <button
                        onClick={() => {
                          setActionsOpen(false);
                          setNote((cur) => cur ?? "");
                          requestAnimationFrame(() => noteInputRef.current?.focus({ preventScroll: true }));
                        }}
                        className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                      >
                        <MessageSquareDashed className={`h-[1.15em] w-[1.15em] ${note !== null ? "text-primary" : ""}`} />
                        {t("note")}
                      </button>
                    )}
                    {api.mode === "session" && api.sessionId && !readOnly && (
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger
                          aria-label={t("messageButtonColor")}
                          className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-left text-base text-foreground/80 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Palette aria-hidden="true" className="h-[1.15em] w-[1.15em]" />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span>{t("messageButtonColor")}</span>
                            <span className="text-xs text-muted-foreground">{t(buttonColorLabels[api.messageButtonColor])}</span>
                          </span>
                          <ChevronDown aria-hidden="true" className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          {...appearance}
                          ref={colorMenuRef}
                          align="start"
                          collisionPadding={8}
                          aria-label={t("messageButtonColor")}
                          className={`${appearance.className} z-[9001] w-[var(--radix-dropdown-menu-trigger-width)] border-current/65`}
                        >
                          {(["default", "lighter", "darker"] as const).map((color) => (
                            <DropdownMenuItem
                              key={color}
                              role="menuitemradio"
                              aria-checked={api.messageButtonColor === color}
                              className="justify-between px-3 py-2"
                              onSelect={() => api.setMessageButtonColor(color)}
                            >
                              {t(buttonColorLabels[color])}
                              {api.messageButtonColor === color && <Check aria-hidden="true" />}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    {/* Search the whole story, loaded or not (chat-search.tsx). */}
                    {api.mode === "session" && api.sessionId && (
                      <button
                        onClick={() => {
                          setActionsOpen(false);
                          window.dispatchEvent(new CustomEvent(OPEN_CHAT_SEARCH_EVENT));
                        }}
                        className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                      >
                        <Search className="h-[1.15em] w-[1.15em]" />
                        {t("searchMessages")}
                      </button>
                    )}
                    {/* Memory: pinned notes and how far back the AI reads.
                        The host mount opens the extension's panel when it is
                        installed, the core one otherwise. */}
                    {api.sessionId && (
                      <button
                        onClick={() => {
                          setActionsOpen(false);
                          window.dispatchEvent(new CustomEvent(OPEN_MEMORY_PANEL_EVENT));
                        }}
                        className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                      >
                        <Brain className="h-[1.15em] w-[1.15em]" />
                        {t("memory")}
                      </button>
                    )}
                    <div className="my-1 h-px bg-border" />
                    <button
                      onClick={handleContinue}
                      className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                    >
                      <FastForward className="h-[1.15em] w-[1.15em]" />
                      {t("continue")}
                    </button>
                    <button
                      onClick={() => {
                        setActionsOpen(false);
                        setConfirmRestart(true);
                      }}
                      className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                    >
                      <RotateCcw className="h-[1.15em] w-[1.15em]" />
                      {t("restartChat")}
                    </button>
                    <div className="my-1 h-px bg-border" />
                    <button
                      onClick={handleOpenPersona}
                      className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                    >
                      <User className="h-[1.15em] w-[1.15em]" />
                      {t("persona")}
                    </button>
                    {(messages?.length ?? 0) > 0 && (
                      <button
                        onClick={handleSharePlaythrough}
                        className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                      >
                        <Share2 className="h-[1.15em] w-[1.15em]" />
                        {t("sharePlaythrough")}
                      </button>
                    )}
                    {api.sessionId && !readOnly && api.storyRoomOffer && (
                      <button
                        onClick={handlePlayWithFriends}
                        className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                      >
                        <Users className="h-[1.15em] w-[1.15em]" />
                        {t("playWithFriends")}
                      </button>
                    )}
                    <button
                      onClick={handleOpenBranch}
                      className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                    >
                      <GitBranch className="h-[1.15em] w-[1.15em]" />
                      {t("branches")}
                    </button>
                    {turnImages?.available && (
                      <>
                        <div className="my-1 h-px bg-border" />
                        <button
                          role="menuitemcheckbox"
                          aria-checked={turnImages.auto}
                          onClick={() => {
                            void setAutoTurnImages(!turnImages.auto).then((ok) => { if (!ok) api.showToast(t("illustrateFailed"), "error"); });
                          }}
                          className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                        >
                          <ImageIcon className="h-[1.15em] w-[1.15em]" />
                          <span className="flex min-w-0 flex-1 flex-col text-left">
                            <span>{t("autoIllustrate")}</span>
                            {!turnImages.unlimited && turnImages.price != null && (
                              <span className="text-xs text-muted-foreground">
                                {(turnImages.freeLeft ?? 0) > 0
                                  ? t("autoIllustrateFree", { count: turnImages.freeLeft ?? 0, price: turnImages.price })
                                  : t("autoIllustratePrice", { price: turnImages.price })}
                              </span>
                            )}
                          </span>
                          <span
                            aria-hidden
                            className={`relative inline-flex h-[1.15em] w-[2.1em] shrink-0 items-center rounded-full transition-colors ${turnImages.auto ? "bg-primary" : "bg-muted-foreground/30"}`}
                          >
                            <span className={`absolute h-[0.85em] w-[0.85em] rounded-full bg-background shadow transition-all ${turnImages.auto ? "left-[1.1em]" : "left-[0.15em]"}`} />
                          </span>
                        </button>
                        {(turnImages.styles?.length ?? 0) > 1 && (
                          <div role="radiogroup" aria-label={t("autoIllustrate")} className="flex gap-1.5 px-3.5 pb-1.5 pl-[2.9em]">
                            {(["default", "detailed", "vivid"] as const).filter((style) => turnImages.styles?.includes(style)).map((style) => {
                              const active = (turnImages.style ?? "default") === style;
                              return (
                                <button
                                  key={style}
                                  role="radio"
                                  aria-checked={active}
                                  onClick={() => {
                                    if (active) return;
                                    void setTurnImageStyle(style).then((ok) => { if (!ok) api.showToast(t("illustrateFailed"), "error"); });
                                  }}
                                  className={`rounded-full px-2.5 py-[0.2em] text-xs transition-colors ${active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                                >
                                  {t(style === "default" ? "illustrateStyleDefault" : style === "detailed" ? "illustrateStyleDetailed" : "illustrateStyleVivid")}
                                  {/* 亮彩 draws one-person pictures without a portrait; the rest stay on the default. */}
                                  {style === "vivid" && <span className="-mt-1 text-[0.7em] leading-none opacity-60" data-illustrate-vivid-tag>{t("illustrateStyleVividTag")}</span>}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                    {filmOn && (
                      <>
                        {!turnImages?.available && <div className="my-1 h-px bg-border" />}
                        <button
                          role="menuitem"
                          onClick={() => { setActionsOpen(false); api.realtimeVideo.openWindow(); }}
                          className="flex w-full items-center gap-3 rounded-md px-3.5 py-[0.65em] text-base text-foreground/80 transition-colors hover:bg-accent"
                        >
                          <Clapperboard className="h-[1.15em] w-[1.15em]" />
                          <span className="flex min-w-0 flex-1 flex-col text-left">
                            <span>{t("sceneVideo")}</span>
                            <span className="text-xs text-muted-foreground">{t("sceneVideoHint")}</span>
                          </span>
                        </button>
                      </>
                    )}
                  </ComposerPopover>
                )}
              </div>

              {/* Branch panel — opens upward from the "+" button. Portaled, so
                  it adds no flex gap here; click-outside is scoped to the
                  panel, not the "+" menu that triggers it. */}
              {branchOpen && (
                <ComposerPopover
                  anchorRef={actionsRef}
                  popoverRef={branchRef}
                  align="left"
                  role="dialog"
                  ariaLabel={t("branches")}
                  className="flex w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
                >
                  <div className="min-h-0 max-h-[60vh] overflow-y-auto">
                    {branchLoading && !branchCtx && (
                      <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground/60">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {t("branchLoading")}
                      </div>
                    )}

                    {branchError && !branchLoading && (
                      <div className="p-4 text-xs text-destructive/80">{t("branchFailed")}</div>
                    )}

                    {branchCtx && !branchError && (
                      <>
                        <BranchSection label={t("branchCurrent")}>
                          <BranchRow node={branchCtx.current} isCurrent t={t} timeAgo={timeAgo} />
                        </BranchSection>

                        {branchCtx.parent && (
                          <BranchSection label={t("branchParent")}>
                            <BranchRow
                              node={branchCtx.parent}
                              onSelect={() => goToBranch(branchCtx.parent!.id)}
                              leadingIcon={<ArrowUp className="h-3 w-3" />}
                              t={t}
                              timeAgo={timeAgo}
                            />
                          </BranchSection>
                        )}

                        {branchCtx.siblings.length > 0 && (
                          <BranchSection label={`${t("branchSiblings")} (${branchCtx.siblings.length})`}>
                            {branchCtx.siblings.map((s) => (
                              <BranchRow key={s.id} node={s} onSelect={() => goToBranch(s.id)} t={t} timeAgo={timeAgo} />
                            ))}
                          </BranchSection>
                        )}

                        {branchCtx.children.length > 0 && (
                          <BranchSection label={`${t("branchChildren")} (${branchCtx.children.length})`}>
                            {branchCtx.children.map((c) => (
                              <BranchRow key={c.id} node={c} onSelect={() => goToBranch(c.id)} t={t} timeAgo={timeAgo} />
                            ))}
                          </BranchSection>
                        )}

                        {!branchCtx.parent &&
                          branchCtx.siblings.length === 0 &&
                          branchCtx.children.length === 0 && (
                            <p className="px-4 py-3 text-[11px] text-muted-foreground/50">{t("branchEmpty")}</p>
                          )}
                      </>
                    )}
                  </div>

                  <div className="shrink-0 border-t border-border p-1.5">
                    <button
                      type="button"
                      onClick={() => void handleBranchFromLatest()}
                      disabled={!canBranchFromLatest || branching}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                    >
                      {branching ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                      ) : (
                        <Plus className="h-3.5 w-3.5 text-primary" />
                      )}
                      {t("branchFromLatest")}
                    </button>
                    <button
                      type="button"
                      onClick={handleOpenManager}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <ListTree className="h-3.5 w-3.5" />
                      {t("openManager")}
                    </button>
                  </div>
                </ComposerPopover>
              )}

              {/* Narrow toolbar + at least one extension → collapse the model
                  pill and extension buttons into a single menu (opens a popover
                  with the model row + every extension's own settings button).
                  Wider toolbars keep the inline pills. */}
              {collapseTools ? (
                <>
                  <ComposerToolMenu onOpenModelPicker={openModelPicker} compactBalance={isTight} />
                  <ThinkingControl />
                </>
              ) : (
                <>
                  <ModelTrigger onClick={openModelPicker} compactBalance={isTight} />
                  <ThinkingControl />
                  {/* Installed extensions' composer contributions (e.g. the
                      session-memory Context button) — see sandbox/extensions/. */}
                  <SlotOutlet point="chat.composer.toolbar" />
                </>
              )}
            </div>

            {/* Right: voice panel + send/stop */}
            <div className="play-composer-send-row flex shrink-0 items-center gap-2">
              {messageLimitState !== "hidden" && (
                <span
                  aria-live="polite"
                  className={`tabular-nums text-[11px] ${
                    messageLimitState === "limit"
                      ? "font-medium text-destructive"
                      : "text-muted-foreground/60"
                  }`}
                >
                  {content.length.toLocaleString()} / {MAX_USER_MESSAGE_CHARS.toLocaleString()}
                </span>
              )}
              <VoicePanelButton />
              {isStreaming && !(api.storyRoom && content.trim()) ? (
                <button
                  onClick={stopGeneration}
                  className="play-composer-stop hover-surface-strong flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground"
                  title={t("stopGeneration")}
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : showMic ? (
                <MicButton voice={voice} disabled={!!api.modelFallback} />
              ) : (
                <button
                  onClick={handleSend}
                  disabled={api.storyRoom ? !content.trim() || !!assist?.writing : (!content.trim() && !images.length && !noteText) || generationBlocked || readingImages || incompatibleImages || !!assist?.writing}
                  className="play-composer-send flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:pointer-events-none disabled:opacity-20"
                  title={t("sendMessage")}
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

// Branch panel i18n lives in ./i18n (sandbox has no react-i18next).
type ChatT = ReturnType<typeof makeChatT>;

function BranchSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="px-3 pt-2.5 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {label}
      </div>
      <div className="px-1 pb-1.5">{children}</div>
    </div>
  );
}

function BranchRow({
  node,
  isCurrent,
  onSelect,
  leadingIcon,
  t,
  timeAgo,
}: {
  node: BranchNode;
  isCurrent?: boolean;
  onSelect?: () => void;
  leadingIcon?: ReactNode;
  t: ChatT;
  timeAgo: (iso: string) => string;
}) {
  const displayName = node.name || t("untitledBranch");
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isCurrent}
      className={`group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
        isCurrent ? "bg-primary/10 cursor-default" : "hover:bg-accent"
      }`}
    >
      {leadingIcon && <span className="shrink-0 text-muted-foreground/60">{leadingIcon}</span>}
      {isCurrent && <Check className="h-3 w-3 shrink-0 text-primary" />}
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[12px] ${isCurrent ? "text-foreground" : "text-foreground/90"}`}>
          {displayName}
        </div>
        <div className="truncate text-[10px] text-muted-foreground/50">
          {node.messageCount} {t("msgs")} · {timeAgo(node.updatedAt)}
        </div>
      </div>
    </button>
  );
}
import { modelFallbackText } from "@yumina/shared";
