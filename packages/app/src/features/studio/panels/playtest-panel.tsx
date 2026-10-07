/** Studio Playtest — unified on the real-play pipeline.
 *
 *  ARCHITECTURAL NOTE (2026-04-18):
 *  Playtest used to be a parallel implementation: its own /api/studio/playtest
 *  endpoint, its own client-side response parser, its own YuminaAPI stub with
 *  no-op audio, its own render path bypassing the sandbox iframe. That parallel
 *  architecture caused repeated drift bugs — BGM didn't play, persona wasn't
 *  injected, notifications dropped, audio effects silently ignored. Every time
 *  a feature was added to real play, it had to be ported into playtest too, and
 *  inevitably wasn't.
 *
 *  Current architecture: playtest is a real session flagged `ephemeral: true`.
 *  This panel saves the world draft, POSTs /api/sessions with the flag, mounts
 *  ChatView on that session id, and deletes the session on unmount. All the
 *  audio / persona / asset / sandbox logic comes for free from the real-play
 *  codebase — there's no playtest-specific code to drift from production.
 *
 *  Session cleanup:
 *    - Normal close → explicit DELETE /api/sessions/:id on unmount.
 *    - Browser force-close / tab crash → row persists briefly as orphan.
 *      Hidden from the session list by the `ephemeral = false` filter, and
 *      reaped by the daily cleanup cron (ephemeral rows older than 24h).
 *      Migration 0019 provides the column + partial index. */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { IDockviewPanelProps } from "dockview-react";
import { Loader2, RotateCcw, AlertCircle, Monitor, Smartphone, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { generatedInterfaceUnsaved, useEditorStore } from "@/stores/editor";
import { useChatStore } from "@/stores/chat";
import { useStudioStore } from "@/stores/studio";
import { ChatView } from "@/features/chat/chat-view";
import { PlaytestRuntimeLog } from "./playtest-runtime-log";
import { PlaytestStarts } from "./playtest-starts";
import { PlaytestRecovery } from "./playtest-recovery";
import { PHONE_VIEW_MODE_STORAGE_KEY, VIEW_MODE_STORAGE_KEY, matchesPhone, readStoredViewMode, subscribePhone, type ViewMode } from "./playtest-view-mode";
import { prepareStudioEntry } from "@/features/editor/editor-entry";
import { NoApiKeyNotice, isNoApiKeyError } from "../components/no-api-key-notice";
import { playtestAffectingChange } from "./playtest-stale";
import type { WorldDefinition } from "@yumina/engine";

const apiBase = import.meta.env.VITE_API_URL || "";

/** Resolves once no save is in flight — at once if none is. Bounded, so a
 *  save that never reports back cannot hold the playtest forever. */
function waitForSaveIdle(timeoutMs = 15_000): Promise<void> {
  if (!useEditorStore.getState().saving) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    // The store may notify before `subscribe` returns; settle on the state
    // as it is once we are listening, not on the order of those two events.
    unsubscribe = useEditorStore.subscribe((state) => { if (!state.saving) done(); });
    if (settled) unsubscribe();
    else if (!useEditorStore.getState().saving) done();
  });
}

type Status = "idle" | "booting" | "ready" | "error";
export function PlaytestPanel(_props: IDockviewPanelProps) {
  const worldId = useEditorStore((s) => s.serverWorldId);
  // Docked/mobile panels can survive a card change. Give each card its own
  // session lifecycle so old loads, selection and cleanup cannot cross cards.
  return <PlaytestSession key={worldId ?? "unsaved"} />;
}

function PlaytestSession() {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const streaming = useChatStore((s) => s.isStreaming);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const phone = useSyncExternalStore(subscribePhone, matchesPhone, () => false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => readStoredViewMode(matchesPhone()));
  const [selectedStartId, setSelectedStartId] = useState("");
  const mountedRef = useRef(false);
  const createTokenRef = useRef(0);
  // The card as the running session was started from, and whether the
  // creator has since changed something that only a fresh start picks up.
  const startedFromRef = useRef<WorldDefinition | null>(null);
  const [stale, setStale] = useState(false);
  // Under ~720px the why-column would squeeze the card: it folds to a rail
  // and opens over the card instead of beside it.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 1000) < 720));
    observer.observe(el);
    return () => observer.disconnect();
  }, [sessionId]);
  // The assistant playing: this panel shows its session instead of one of
  // its own, reloads it after every turn, and keeps the creator's hands off
  // it until the assistant is done.
  const aiPlaytest = useStudioStore((s) => s.aiPlaytest);
  const aiPlaying = !!aiPlaytest && !aiPlaytest.done;
  const stageAssistant = useStudioStore((s) => s.stageAssistant);

  const updateViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(phone ? PHONE_VIEW_MODE_STORAGE_KEY : VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Private mode / disabled storage — toggle still works for this session.
    }
  };

  // Track the active session so the cleanup effect sees the latest id even when
  // resetPlaytest swaps it out without re-running the mount effect.
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  // ── Create / recreate an ephemeral playtest session ──
  // Called on mount and whenever the user hits reset. Saves the draft first so
  // the session's world definition reflects what's currently in the editor
  // (unsaved edits would otherwise render from the last-saved version).
  async function createPlaytestSession(startId = ""): Promise<string | null> {
    const token = ++createTokenRef.current;
    let newId: string | undefined;
    if (!serverWorldId) {
      setError(t("blueprint.insp.playtestSaveFirst"));
      setStatus("error");
      return null;
    }
    setStatus("booting");
    setError(null);
    try {
      // A save already in flight (the autosave, or the one the creator just
      // pressed) makes prepareStudioEntry give up rather than queue behind
      // it — and this panel mounts right after a burst of writing, in the
      // tutorial's last step above all. It came up as "the draft is still
      // saving" with a retry button, for a wait of a second or two. Wait it
      // out here instead.
      await waitForSaveIdle();
      if (!mountedRef.current || token !== createTokenRef.current) return null;
      const editor = useEditorStore.getState();
      if (!editor.isDirty && generatedInterfaceUnsaved(editor)) await editor.saveDraft();
      // Flush draft so the new session starts from the latest editor state.
      // saveDraft is a no-op when not dirty, cheap to always call.
      const savedId = await prepareStudioEntry(useEditorStore.getState);
      if (savedId !== serverWorldId) throw new Error(t("studio.testStarts.draftNotReady", { defaultValue: "草稿仍在保存或保存期间有新修改，请保存完成后再运行。" }));

      if (!mountedRef.current || token !== createTokenRef.current) return null;
      useChatStore.getState().stopGeneration();
      const res = await fetch(startId
        ? `${apiBase}/api/sessions/studio-test-starts/${startId}/run`
        : `${apiBase}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ worldId: serverWorldId, ephemeral: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
        setStatus("error");
        return null;
      }
      const { data } = await res.json();
      newId = data?.id as string | undefined;
      if (!newId) {
        setError(t("blueprint.insp.playtestNoSession"));
        setStatus("error");
        return null;
      }
      if (!mountedRef.current || token !== createTokenRef.current) {
        void deletePlaytestSession(newId);
        return null;
      }
      // Load into chat store so ChatView can render from the same session it
      // would use for real play — greeting, audio tracks, persona, all of it.
      await useChatStore.getState().loadSession(newId, () => mountedRef.current && token === createTokenRef.current);
      if (!mountedRef.current || token !== createTokenRef.current) {
        void deletePlaytestSession(newId);
        return null;
      }
      if (useChatStore.getState().session?.id !== newId) throw new Error(t("studio.playtest.bootError"));
      useChatStore.getState().startRuntimeRecording(newId);
      startedFromRef.current = useEditorStore.getState().worldDraft;
      setStale(false);
      sessionIdRef.current = newId;
      setSessionId(newId);
      setStatus("ready");
      return newId;
    } catch (e) {
      if (newId) void deletePlaytestSession(newId);
      if (!mountedRef.current || token !== createTokenRef.current) return null;
      setError(e instanceof Error ? e.message : t("extra.playtestFailed"));
      setStatus("error");
      return null;
    }
  }

  // ── Delete the current session (called on unmount and on reset) ──
  async function deletePlaytestSession(id: string | null) {
    if (!id) return;
    useChatStore.getState().stopRuntimeRecording(id);
    if (useChatStore.getState().session?.id === id) {
      const chat = useChatStore.getState();
      chat.stopGeneration(); chat.setSession(null); chat.setMessages([]); chat.setGameState({});
    }
    try {
      await fetch(`${apiBase}/api/sessions/${id}`, {
        method: "DELETE",
        credentials: "include",
        // keepalive so the fetch survives a tab close — the cleanup cron is
        // backup, not primary, so we do want best-effort deletion here.
        keepalive: true,
      });
    } catch {
      // Best-effort — cleanup cron picks up orphans.
    }
  }

  // Follow the assistant's session: adopt it, and reload it after each turn.
  useEffect(() => {
    if (!aiPlaytest) return;
    const id = aiPlaytest.sessionId;
    const previous = sessionIdRef.current;
    createTokenRef.current += 1;
    if (previous && previous !== id) void deletePlaytestSession(previous);
    sessionIdRef.current = id;
    setSessionId(id);
    setStale(false);
    setError(null);
    void useChatStore.getState().loadSession(id, () => mountedRef.current && sessionIdRef.current === id).then(() => {
      if (mountedRef.current && sessionIdRef.current === id) setStatus("ready");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPlaytest?.sessionId, aiPlaytest?.turn, aiPlaytest?.done]);

  // ── Mount: create session. Unmount: delete. ──
  useEffect(() => {
    mountedRef.current = true;
    // Opened because the assistant started playing: its session is the one to show.
    if (!useStudioStore.getState().aiPlaytest) void createPlaytestSession();
    return () => {
      mountedRef.current = false;
      createTokenRef.current += 1;
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      // Never pull a session out from under the assistant mid-play.
      const ai = useStudioStore.getState().aiPlaytest;
      if (!(ai && ai.sessionId === id && !ai.done)) void deletePlaytestSession(id);
    };
    // We intentionally only run once on mount. Reset is a separate handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An edit that changes play marks the running session stale. Checked a beat
  // after typing stops: comparing the play-relevant parts of a big card on
  // every keystroke would be wasted work.
  useEffect(() => {
    if (status !== "ready" || stale) return;
    const timer = setTimeout(() => {
      const started = startedFromRef.current;
      if (started && playtestAffectingChange(started, useEditorStore.getState().worldDraft)) setStale(true);
    }, 600);
    return () => clearTimeout(timer);
  }, [worldDraft, status, stale]);

  // ── Reset: delete current session, create a fresh one. ──
  async function handleReset(startId = selectedStartId) {
    if (useChatStore.getState().isStreaming || status === "booting" || aiPlaying) return;
    // Starting their own run hands the panel back to the creator.
    if (useStudioStore.getState().aiPlaytest) useStudioStore.setState({ aiPlaytest: null });
    // Loaded on use, not at module load: posthog-js reads `location` the
    // moment it is imported, and this panel's lifecycle test runs without one.
    void import("@/lib/analytics").then(({ captureHubEvent }) =>
      captureHubEvent("studio_playtest_started", { world_id: serverWorldId ?? "", from: startId ? "checkpoint" : "start" }),
    );
    const prevId = sessionIdRef.current;
    const nextId = await createPlaytestSession(startId);
    if (nextId && prevId !== nextId) void deletePlaytestSession(prevId);
  }

  // The view toggle and restart. On a phone they ride at the end of the test
  // start row instead of taking a header row of their own.
  const controls = (
    <>
      <div
        className="flex items-center gap-0.5 rounded-md border border-border/70 bg-card/50 p-0.5"
        role="group"
        aria-label={t("studio.playtest.viewModeGroup")}
      >
        <button
          type="button"
          onClick={() => updateViewMode("desktop")}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded transition-colors",
            viewMode === "desktop"
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={t("studio.playtest.viewDesktop")}
          aria-label={t("studio.playtest.viewDesktop")}
          aria-pressed={viewMode === "desktop"}
        >
          <Monitor className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => updateViewMode("mobile")}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded transition-colors",
            viewMode === "mobile"
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={t("studio.playtest.viewMobile")}
          aria-label={t("studio.playtest.viewMobile")}
          aria-pressed={viewMode === "mobile"}
        >
          <Smartphone className="h-3 w-3" />
        </button>
      </div>
      <button
        onClick={() => void handleReset()}
        disabled={status === "booting" || streaming}
        className="hover-surface rounded-md p-1 text-muted-foreground disabled:opacity-40"
        title={t("studio.playtest.restart")}
      >
        <RotateCcw className={cn("h-3.5 w-3.5", status === "booting" && "animate-spin")} />
      </button>
      {stageAssistant && (
        <button
          type="button"
          onClick={stageAssistant.toggle}
          aria-pressed={stageAssistant.open}
          className={cn("hover-surface rounded-md p-1", stageAssistant.open ? "text-primary" : "text-muted-foreground")}
          title={t("studio.panels.aiAssistant")}
          aria-label={t("studio.panels.aiAssistant")}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </button>
      )}
    </>
  );
  // One quiet row on every screen: the start picker, its buttons, the view
  // toggle and restart. The old desktop header (title · 测试 over a full-width
  // 「测试起点」 row and a line of fine print) was a test bench above a screen
  // that is meant to look like the player's.
  const compactTop = !!serverWorldId;
  // On a phone the phone preview IS the phone: no bezel, fake status bar or
  // padding shrinking it, so the card lays out at the phone's own width.
  const framed = viewMode === "mobile" && !phone;
  // A card's stage picks its wide canvas when the box is wider than ~1.15:1,
  // then scales 1024px into ~370px. A short phone box (browser bars, a small
  // phone) tipped it there, so the phone preview never gets shorter than a
  // phone-shaped box; the pane scrolls instead.
  const phoneShaped = viewMode === "mobile" && phone;
  // The card gets exactly the pane it is shown in, an arranged card (a uiDoc
  // with parts) included. It used to get a phone-tall box (100vw × 2.08,
  // ~811px) in a ~560px pane so it would not be scaled down, which made the
  // pane the scroller: a reply scrolled it ~250px, the status panel at the top
  // of the card went off screen, and the composer sat half under 运行记录.
  // Sized to the pane, the card fits whole and scrolls only inside itself.

  return (
    <div className="flex h-full flex-col bg-background" data-onboarding="playtest">
      {/* Minimal header — ChatView renders its own session header inside. */}
      {!compactTop && <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
          {worldDraft.name || t("studio.playtest.untitled")} · {t("studio.playtest.label")}
        </span>
        {controls}
      </div>}

      {serverWorldId && <PlaytestStarts worldId={serverWorldId} sessionId={sessionId} selectedId={selectedStartId}
        onSelect={setSelectedStartId} onRun={handleReset} busy={status === "booting"}
        compact={compactTop} trailing={compactTop ? controls : undefined} />}

      {status === "ready" && sessionId && <PlaytestRecovery key={sessionId} sessionId={sessionId} />}

      {status === "ready" && stale && (
        <div data-playtest-stale className="flex items-center gap-2 border-b border-border bg-primary/10 px-3 py-1.5 text-xs text-foreground" role="status">
          <span className="min-w-0 flex-1">{t("studio.playtest.staleHint")}</span>
          <button
            type="button"
            onClick={() => void handleReset()}
            disabled={streaming}
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            {t("studio.playtest.staleRestart")}
          </button>
        </div>
      )}

      <div ref={rowRef} className="relative flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {status === "error" && (
          <div data-playtest-recovery="start" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            {isNoApiKeyError(error) ? (
              <NoApiKeyNotice />
            ) : (
              <>
                <AlertCircle className="h-6 w-6 text-destructive" />
                <p className="text-xs text-destructive">{error ?? t("studio.playtest.bootError")}</p>
              </>
            )}
            <button
              onClick={() => void handleReset()}
              className="mt-2 rounded-md bg-primary/90 px-3 py-1.5 text-xs text-primary-foreground"
            >
              {t("studio.playtest.retry")}
            </button>
          </div>
        )}
        {status !== "error" && sessionId && (
          // Wrapper is intentionally always rendered so React keeps ChatView
          // mounted across desktop/mobile toggles — only classes change.
          // Remounting would re-fetch the session and lose audio/scroll state.
          <div
            className={cn(
              "flex h-full w-full",
              framed && "justify-center bg-muted/30 p-2 sm:p-6",
              phoneShaped && "overflow-y-auto",
            )}
          >
            <div
              className={cn(
                "flex h-full w-full flex-col",
                framed &&
                  "max-w-[414px] overflow-hidden rounded-2xl border-2 border-border bg-background shadow-2xl",
                phoneShaped && "min-h-[380px]",
              )}
            >
              <div
                className={cn(
                  "shrink-0 flex items-center justify-between px-4 py-1.5 text-[10px] text-muted-foreground/50",
                  !framed && "hidden",
                )}
              >
                <span>9:41</span>
                <span className="truncate">{worldDraft.name || "Yumina"}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden" inert={aiPlaying || undefined}>
                <ChatView sessionId={sessionId} isActive={true} embedded />
              </div>
              <div
                className={cn(
                  "shrink-0 flex justify-center pb-2 pt-1",
                  !framed && "hidden",
                )}
              >
                <div className="h-1 w-24 rounded-full bg-muted-foreground/30" />
              </div>
            </div>
          </div>
        )}
        {status === "booting" && !sessionId && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
      {status === "ready" && sessionId && <PlaytestRuntimeLog key={narrow ? "overlay" : "column"} sessionId={sessionId} overlay={narrow} />}
      </div>
    </div>
  );
}
