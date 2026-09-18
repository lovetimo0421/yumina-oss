import { useStoryNavigation } from "@/hooks/use-story-navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Gamepad2,
  GitBranch,
  Loader2,
  MessageSquare,
  Pencil,
  Trash2,
  Check,
  X,
} from "lucide-react";
import { formatPlaytimeHours } from "@/lib/playtime";
import { formatTimeAgo } from "@/lib/format-time";
import { useUiStore } from "@/stores/ui";
import {
  SESSION_MODAL_BACKDROP_CLASS,
  SESSION_MODAL_GROUP_CLASS,
  SESSION_MODAL_SURFACE_CLASS,
} from "@/components/session-modal-styles";
import { navigateFromSessionManager } from "./session-manager-navigation";

const apiBase = import.meta.env.VITE_API_URL || "";

interface SessionItem {
  id: string;
  name: string | null;
  worldId: string;
  worldName: string;
  worldStatus: string;
  worldLanguage: string | null;
  worldThumbnailUrl: string | null;
  playtimeSeconds: number;
  messageCount: number;
  lastMessagePreview: string | null;
  parentSessionId: string | null;
  branchedFromMessageId: string | null;
  childBranchCount: number;
  createdAt: string;
  updatedAt: string;
}

interface WorldGroup {
  worldId: string;
  worldName: string;
  worldThumbnailUrl: string | null;
  sessions: SessionItem[];
  latestUpdatedAt: string;
}

interface SessionNode {
  session: SessionItem;
  children: SessionNode[];
}

function buildSessionForest(sessions: SessionItem[]): SessionNode[] {
  const nodeMap = new Map<string, SessionNode>();
  for (const s of sessions) {
    nodeMap.set(s.id, { session: s, children: [] });
  }
  const roots: SessionNode[] = [];
  for (const node of nodeMap.values()) {
    const parentId = node.session.parentSessionId;
    if (parentId && nodeMap.has(parentId)) {
      nodeMap.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort children by createdAt ascending (branch 1 before branch 2)
  const sortChildren = (n: SessionNode) => {
    n.children.sort((a, b) => new Date(a.session.createdAt).getTime() - new Date(b.session.createdAt).getTime());
    n.children.forEach(sortChildren);
  };
  roots.forEach(sortChildren);
  // Roots sorted by updatedAt desc (most recent first)
  roots.sort((a, b) => new Date(b.session.updatedAt).getTime() - new Date(a.session.updatedAt).getTime());
  return roots;
}

function SessionManagerModalImpl() {
  const open = useUiStore((s) => s.sessionManagerOpen);
  const close = useUiStore((s) => s.closeSessionManager);
  const { t, i18n } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const navigateToStory = useStoryNavigation();
  const contentRef = useRef<HTMLDivElement>(null);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedWorlds, setExpandedWorlds] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteWorldId, setConfirmDeleteWorldId] = useState<string | null>(null);
  const [deletingWorldId, setDeletingWorldId] = useState<string | null>(null);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const initializedExpansionRef = useRef(false);

  // Stable ordinal map — only computed once per fetch, not on delete
  const stableOrdinalsRef = useRef(new Map<string, number>());

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/sessions`, { credentials: "include" });
      if (res.ok) {
        const { data } = await res.json();
        const items: SessionItem[] = data ?? [];
        setSessions(items);

        // Build stable ordinals per world on fetch
        const worldSessions = new Map<string, SessionItem[]>();
        for (const s of items) {
          const arr = worldSessions.get(s.worldId) ?? [];
          arr.push(s);
          worldSessions.set(s.worldId, arr);
        }
        const ordinals = new Map<string, number>();
        for (const arr of worldSessions.values()) {
          arr.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          arr.forEach((s, i) => ordinals.set(s.id, i + 1));
        }
        stableOrdinalsRef.current = ordinals;
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setSessions([]);
      setExpandedWorlds(new Set());
      initializedExpansionRef.current = false;
      void fetchSessions();
      setRenamingId(null);
      setConfirmDeleteId(null);
      setConfirmDeleteWorldId(null);
      setEnteringId(null);
    }
  }, [open, fetchSessions]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (renamingId) setRenamingId(null);
        else close();
      }
    };
    document.addEventListener("keydown", handler);
    contentRef.current?.focus();
    return () => document.removeEventListener("keydown", handler);
  }, [open, close, renamingId]);

  const groups = useMemo<WorldGroup[]>(() => {
    const map = new Map<string, WorldGroup>();
    for (const s of sessions) {
      let group = map.get(s.worldId);
      if (!group) {
        group = {
          worldId: s.worldId,
          worldName: s.worldName ?? t("unknownWorld"),
          worldThumbnailUrl: s.worldThumbnailUrl ?? null,
          sessions: [],
          latestUpdatedAt: s.updatedAt,
        };
        map.set(s.worldId, group);
      }
      group.sessions.push(s);
      if (new Date(s.updatedAt).getTime() > new Date(group.latestUpdatedAt).getTime()) {
        group.latestUpdatedAt = s.updatedAt;
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.latestUpdatedAt).getTime() - new Date(a.latestUpdatedAt).getTime(),
    );
  }, [sessions, t]);

  // Expand only the most recently active world on first load. Some production
  // accounts have hundreds of sessions and very deep branch trees; mounting
  // every row at once can stall or reload a memory-constrained mobile tab.
  useEffect(() => {
    if (!open || groups.length === 0 || initializedExpansionRef.current) return;
    initializedExpansionRef.current = true;
    setExpandedWorlds(new Set([groups[0]!.worldId]));
  }, [groups, open]);

  const toggleExpand = (worldId: string) => {
    setExpandedWorlds((prev) => {
      const next = new Set(prev);
      if (next.has(worldId)) next.delete(worldId);
      else next.add(worldId);
      return next;
    });
  };

  const startRename = (session: SessionItem) => {
    setRenamingId(session.id);
    setRenameValue(session.name ?? "");
    setConfirmDeleteId(null);
    window.setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const submitRename = async (sessionId: string) => {
    const trimmed = renameValue.trim().slice(0, 100);
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, name: trimmed || null } : s)),
    );
    setRenamingId(null);
    try {
      const res = await fetch(`${apiBase}/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error();
      // T0: the row already shows the new name — the rename is its own receipt.
    } catch {
      // R7: the rename input has closed, so the failure has nothing left to
      // anchor to. Retry reopens the row's editor with the same text.
      await fetchSessions();
      feedback.error(t("header.renameFailed", "Couldn't rename the session"), {
        label: tCommon("action.retry"),
        onClick: () => {
          setRenameValue(trimmed);
          setRenamingId(sessionId);
        },
      });
    }
  };

  // R5 variant (b): there is no session-restore endpoint, so the row leaves the
  // list at once and the DELETE waits for the undo window to close. Undo just
  // puts the row back — nothing was ever sent.
  const handleDeleteSession = (sessionId: string) => {
    const at = sessions.findIndex((s) => s.id === sessionId);
    const removed = sessions[at];
    if (!removed) return;
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setConfirmDeleteId(null);
    const restore = () =>
      setSessions((prev) =>
        prev.some((s) => s.id === sessionId)
          ? prev
          : [...prev.slice(0, at), removed, ...prev.slice(at)],
      );
    const deleteFailed = () => {
      restore();
      feedback.error(t("header.deleteFailed", "Couldn't delete the session"));
    };
    feedback.undo(t("header.sessionDeleted"), restore, {
      onCommit: () => {
        void fetch(`${apiBase}/api/sessions/${sessionId}`, {
          method: "DELETE",
          credentials: "include",
        })
          .then((res) => {
            if (!res.ok) deleteFailed();
          })
          .catch(deleteFailed);
      },
    });
  };

  const handleDeleteWorld = async (worldId: string) => {
    const worldSessions = sessions.filter((s) => s.worldId === worldId);
    setDeletingWorldId(worldId);
    try {
      const results = await Promise.all(
        worldSessions.map((s) =>
          fetch(`${apiBase}/api/sessions/${s.id}`, { method: "DELETE", credentials: "include" }),
        ),
      );
      if (!results.every((r) => r.ok)) {
        feedback.error(t("header.deleteSomeFailed", "Some sessions weren't deleted"));
        await fetchSessions();
        return;
      }
      setSessions((prev) => prev.filter((s) => s.worldId !== worldId));
      setExpandedWorlds((prev) => {
        const next = new Set(prev);
        next.delete(worldId);
        return next;
      });
      // Wiping every session of a world means the user is done with it — clear
      // it from the mobile drawer's "recent worlds" list too.
      useUiStore.getState().removeRecentPlayedWorld(worldId);
      // T0: the whole world group has left the list — the count told the user
      // nothing they couldn't see.
    } catch {
      // The batch threw part-way, so how many survived is unknown — the same
      // copy as the partial case, then a refetch shows the truth.
      feedback.error(t("header.deleteSomeFailed", "Some sessions weren't deleted"));
      await fetchSessions();
    } finally {
      setDeletingWorldId(null);
      setConfirmDeleteWorldId(null);
    }
  };

  const enterSession = async (sessionId: string) => {
    if (enteringId) return;
    setEnteringId(sessionId);
    try {
      await navigateFromSessionManager({
        sessionId,
        navigate: (id) => navigateToStory(id),
        close,
      });
    } catch {
      // R7: the navigation never happened, so the pill is the only surface left.
      feedback.error(t("header.loadSessionFailed", "Couldn't open the session"), {
        label: tCommon("action.retry"),
        onClick: () => void enterSession(sessionId),
      });
    } finally {
      setEnteringId(null);
    }
  };

  const renderSessionNode = (node: SessionNode, depth: number): React.ReactNode => {
    const { session } = node;
    const isRenaming = renamingId === session.id;
    const isConfirming = confirmDeleteId === session.id;
    const isEntering = enteringId === session.id;
    const ordinal = stableOrdinalsRef.current.get(session.id) ?? 1;
    const displayName = session.name?.trim() || `Session ${ordinal}`;
    // Preserve the branch relationship without pushing deep production trees
    // hundreds of pixels off-screen on phones (the current maximum is 78).
    const indentStyle = { paddingLeft: `${Math.min(depth, 4) * 16}px` };

    return (
      <div key={session.id} style={indentStyle}>
        {isRenaming ? (
          <div className="rounded-lg border border-primary/20 bg-primary/[0.03] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") void submitRename(session.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                maxLength={100}
                placeholder={t("header.sessionName")}
                className="h-7 flex-1 rounded-md border border-white/[0.08] bg-black/20 px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-primary/40"
              />
              <button
                onClick={() => void submitRename(session.id)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors hover:bg-primary/20"
              >
                <Check className="h-3 w-3" />
              </button>
              <button
                onClick={() => setRenamingId(null)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-muted-foreground transition-colors hover:bg-white/[0.08]"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              className="group cursor-pointer rounded-lg px-3 py-2 transition-all hover:bg-white/[0.03]"
              aria-busy={isEntering}
              onClick={() => {
                if (!isConfirming && !enteringId) void enterSession(session.id);
              }}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">
                  {displayName}
                  {session.parentSessionId && (
                    <span className="ml-2 inline-flex items-center rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">
                      <GitBranch className="mr-1 h-2 w-2" />
                      {t("header.branchBadge")}
                    </span>
                  )}
                  {session.childBranchCount > 0 && (
                    <span className="ml-2 text-[10px] text-muted-foreground/40">
                      {t("header.branchCount", { count: session.childBranchCount })}
                    </span>
                  )}
                </span>
                {isEntering && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
                <div
                  className="session-row-actions touch-reveal flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => startRename(session)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                    title={t("header.renameSession")}
                    aria-label={t("header.renameSession")}
                  >
                    <Pencil className="h-2.5 w-2.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDeleteId(session.id);
                      setConfirmDeleteWorldId(null);
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title={t("header.deleteSession")}
                    aria-label={t("header.deleteSession")}
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </button>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/30">
                <span className="flex items-center gap-1">
                  <MessageSquare className="h-2.5 w-2.5" />
                  {session.messageCount}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-2.5 w-2.5" />
                  {formatPlaytimeHours(session.playtimeSeconds)}
                </span>
                <span>{formatTimeAgo(session.updatedAt, i18n.language)}</span>
              </div>
              {session.lastMessagePreview && (
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/20 italic">
                  {session.lastMessagePreview}
                </p>
              )}
            </div>

            {isConfirming && (
              <div className="mx-3 mb-1 flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/[0.04] px-2.5 py-1.5">
                <span className="flex-1 text-[11px] text-destructive/80">
                  {t("header.deleteConfirm")}
                </span>
                <button
                  onClick={() => handleDeleteSession(session.id)}
                  className="rounded-md bg-destructive px-2.5 py-0.5 text-[11px] font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
                >
                  {t("header.yes")}
                </button>
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  className="rounded-md bg-white/[0.06] px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.1]"
                >
                  {t("header.no")}
                </button>
              </div>
            )}
          </>
        )}
        {node.children.map((child) => renderSessionNode(child, depth + 1))}
      </div>
    );
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className={SESSION_MODAL_BACKDROP_CLASS}
        onClick={close}
      />

      {/* Modal */}
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-label="Session manager"
        tabIndex={-1}
        className={`${SESSION_MODAL_SURFACE_CLASS} max-w-lg`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <div>
            <h2 className="text-[0.95rem] font-semibold text-foreground">
              {tCommon("mobile.manageSessions")}
            </h2>
            {sessions.length > 0 && (
              <p className="mt-0.5 text-[11px] text-muted-foreground/40">
                {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mx-5 h-px bg-white/[0.06]" />

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-muted-foreground/30">
              <Gamepad2 className="mb-2 h-8 w-8" />
              <p className="text-sm">{t("header.noSessions")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {groups.map((group) => {
                const isExpanded = expandedWorlds.has(group.worldId);
                const isConfirmingWorld = confirmDeleteWorldId === group.worldId;
                const isDeletingWorld = deletingWorldId === group.worldId;

                return (
                  <div
                    key={group.worldId}
                    className={SESSION_MODAL_GROUP_CLASS}
                  >
                    {/* World header */}
                    <div className="flex items-center gap-2.5 px-3.5 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggleExpand(group.worldId)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <div className="h-8 w-8 shrink-0 overflow-hidden rounded-lg">
                          {group.worldThumbnailUrl ? (
                            <img
                              src={group.worldThumbnailUrl}
                              alt={group.worldName}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-white/[0.04]">
                              <Gamepad2 className="h-3.5 w-3.5 text-muted-foreground/30" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-semibold text-foreground">
                            {group.worldName}
                          </p>
                          <p className="text-[10px] text-muted-foreground/35">
                            {group.sessions.length}{" "}
                            {group.sessions.length === 1 ? "session" : "sessions"}
                          </p>
                        </div>
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/20" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/20" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeleteWorldId(isConfirmingWorld ? null : group.worldId);
                          setConfirmDeleteId(null);
                        }}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/25 transition-colors hover:bg-destructive/10 hover:text-destructive"
                        title={t("deleteAllSessions")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>

                    {/* World delete confirmation */}
                    {isConfirmingWorld && (
                      <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/[0.04] px-3 py-2">
                        <span className="flex-1 text-xs text-destructive/80">
                          Delete all {group.sessions.length} session
                          {group.sessions.length > 1 ? "s" : ""}?
                        </span>
                        <button
                          onClick={() => void handleDeleteWorld(group.worldId)}
                          disabled={isDeletingWorld}
                          className="rounded-lg bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
                        >
                          {isDeletingWorld ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            t("header.yes")
                          )}
                        </button>
                        <button
                          onClick={() => setConfirmDeleteWorldId(null)}
                          className="rounded-lg bg-white/[0.06] px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.1]"
                        >
                          {t("header.no")}
                        </button>
                      </div>
                    )}

                    {/* Sessions */}
                    {isExpanded && (
                      <div className="border-t border-white/[0.03] px-1.5 pb-1.5 pt-0.5">
                        {buildSessionForest(group.sessions).map((node) => renderSessionNode(node, 0))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const SessionManagerModal = memo(SessionManagerModalImpl);
