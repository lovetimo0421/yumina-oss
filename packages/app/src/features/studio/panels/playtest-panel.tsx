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

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IDockviewPanelProps } from "dockview-react";
import { Loader2, RotateCcw, AlertCircle, Monitor, Smartphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { useChatStore } from "@/stores/chat";
import { ChatView } from "@/features/chat/chat-view";

const apiBase = import.meta.env.VITE_API_URL || "";

type Status = "idle" | "booting" | "ready" | "error";
type ViewMode = "desktop" | "mobile";

const VIEW_MODE_STORAGE_KEY = "yumina.studio.playtest.viewMode";

function readStoredViewMode(): ViewMode {
  if (typeof window === "undefined") return "desktop";
  try {
    const v = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return v === "mobile" ? "mobile" : "desktop";
  } catch {
    return "desktop";
  }
}

export function PlaytestPanel(_props: IDockviewPanelProps) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const isDirty = useEditorStore((s) => s.isDirty);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(readStoredViewMode);

  const updateViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
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
  async function createPlaytestSession(): Promise<string | null> {
    if (!serverWorldId) {
      setError("Save the world first — playtest needs a persisted world id.");
      setStatus("error");
      return null;
    }
    setStatus("booting");
    setError(null);
    try {
      // Flush draft so the new session starts from the latest editor state.
      // saveDraft is a no-op when not dirty, cheap to always call.
      if (isDirty) {
        const saved = await saveDraft();
        if (!saved) {
          setError("Failed to save draft before starting playtest.");
          setStatus("error");
          return null;
        }
      }

      const res = await fetch(`${apiBase}/api/sessions`, {
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
      const newId = data?.id as string | undefined;
      if (!newId) {
        setError("Session creation returned no id.");
        setStatus("error");
        return null;
      }
      // Load into chat store so ChatView can render from the same session it
      // would use for real play — greeting, audio tracks, persona, all of it.
      await useChatStore.getState().loadSession(newId);
      setSessionId(newId);
      setStatus("ready");
      return newId;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("extra.playtestFailed"));
      setStatus("error");
      return null;
    }
  }

  // ── Delete the current session (called on unmount and on reset) ──
  async function deletePlaytestSession(id: string | null) {
    if (!id) return;
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

  // ── Mount: create session. Unmount: delete. ──
  useEffect(() => {
    void createPlaytestSession();
    return () => {
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      void deletePlaytestSession(id);
    };
    // We intentionally only run once on mount. Reset is a separate handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reset: delete current session, create a fresh one. ──
  async function handleReset() {
    const prevId = sessionIdRef.current;
    setSessionId(null);
    setStatus("booting");
    // Fire-and-forget the delete — creating the new session doesn't depend on
    // the old one being gone, and parallel calls are safer on DB than serial.
    void deletePlaytestSession(prevId);
    await createPlaytestSession();
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Minimal header — ChatView renders its own session header inside. */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
          {worldDraft.name || t("studio.playtest.untitled")} · {t("studio.playtest.label")}
        </span>
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
          onClick={handleReset}
          disabled={status === "booting"}
          className="hover-surface rounded-md p-1 text-muted-foreground disabled:opacity-40"
          title={t("studio.playtest.restart")}
        >
          <RotateCcw className={cn("h-3.5 w-3.5", status === "booting" && "animate-spin")} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {status === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <p className="text-xs text-destructive">{error ?? t("studio.playtest.bootError")}</p>
            <button
              onClick={handleReset}
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
              viewMode === "mobile" && "justify-center bg-muted/30 p-2 sm:p-6",
            )}
          >
            <div
              className={cn(
                "flex h-full w-full flex-col",
                viewMode === "mobile" &&
                  "max-w-[414px] overflow-hidden rounded-2xl border-2 border-border bg-background shadow-2xl",
              )}
            >
              <div
                className={cn(
                  "shrink-0 flex items-center justify-between px-4 py-1.5 text-[10px] text-muted-foreground/50",
                  viewMode === "desktop" && "hidden",
                )}
              >
                <span>9:41</span>
                <span className="truncate">{worldDraft.name || "Yumina"}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <ChatView sessionId={sessionId} isActive={true} />
              </div>
              <div
                className={cn(
                  "shrink-0 flex justify-center pb-2 pt-1",
                  viewMode === "desktop" && "hidden",
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
    </div>
  );
}
