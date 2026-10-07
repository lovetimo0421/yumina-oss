import { memo, useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  Plus,
  X,
  MessageSquare,
  Clock,
  Pencil,
  Trash2,
  Check,
  Globe,
} from "lucide-react";
import { feedback } from "@/lib/feedback";
import { formatPlaytimeShort } from "@/lib/playtime";
import { formatTimeAgo } from "@/lib/format-time";
import type { LanguageVariant } from "@/lib/languages";
import { LANGUAGE_SHORT, variantRowLabels } from "@/lib/languages";
import {
  SESSION_MODAL_BACKDROP_CLASS,
  SESSION_MODAL_GROUP_CLASS,
  SESSION_MODAL_SURFACE_CLASS,
} from "@/components/session-modal-styles";
import { useSession } from "@/lib/auth-client";
import { soleCurrentLanguageVariant } from "@/components/version-picker-modal";
import { getCachedSessions, setCachedSessions } from "@/lib/session-picker-cache";
import { WorldPersonaIconMenu } from "@/features/chat/world-persona-menu";
import { usePersonasStore } from "@/stores/personas";

const apiBase = import.meta.env.VITE_API_URL || "";

interface SessionItem {
  id: string;
  name: string | null;
  worldId: string;
  worldName: string;
  worldLanguage: string | null;
  playtimeSeconds: number;
  messageCount: number;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionPickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (worldId: string) => void;
  world: {
    id: string;
    name: string;
    languageGroupId?: string | null;
    language?: string | null;
  };
  variants: LanguageVariant[];
  creating?: boolean;
}

function versionBadgeText(session: SessionItem, variants: LanguageVariant[]): string | null {
  const variant = variants.find((v) => v.id === session.worldId);
  if (!variant) return null;
  if (variant.language && LANGUAGE_SHORT[variant.language]) return LANGUAGE_SHORT[variant.language];
  return null;
}

function SessionPickerModalImpl({
  open,
  onClose,
  onSelectSession,
  onCreateSession,
  world,
  variants,
  creating,
}: SessionPickerModalProps) {
  const { t, i18n } = useTranslation(["chat", "common"]);
  const { t: tProfile } = useTranslation("profile");
  const contentRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const refreshPendingRef = useRef(false);
  const deleteLockRef = useRef(false);
  const scopeRef = useRef(0);
  const hasVariants = variants.length > 1;

  // The cached list is scoped to the signed-in user (see session-picker-cache):
  // the same tab can go sign-out → sign-in as another account without a
  // reload, and a save from the previous account 404s for this one.
  const { data: authSession } = useSession();
  const userId = authSession?.user?.id ?? null;

  const cacheKey =
    hasVariants && world.languageGroupId
      ? `group:${world.languageGroupId}`
      : `world:${world.id}`;

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [showVersionPicker, setShowVersionPicker] = useState(false);
  const [newSessionVersionId, setNewSessionVersionId] = useState<string>(world.id);
  const [showAllLanguages, setShowAllLanguages] = useState(false);
  const selectionBlocked = usePersonasStore((s) => s.savingSelection || s.selectionFailed);
  const selectionFailed = usePersonasStore((s) => s.selectionFailed);

  // Compare by base language so a Traditional (zh-Hant) UI still treats zh
  // variants as the "current language" — Traditional and Simplified share one
  // catalog, so a zh card is not a foreign-language variant to a zh-Hant reader.
  const uiLangBase = i18n.language.split("-")[0];
  const isCurrentLang = (v: { language: string | null }) =>
    (v.language ?? "").split("-")[0] === uiLangBase;
  const variantsInCurrentLanguage = variants.filter(isCurrentLang);
  const hasOtherLanguageVariants =
    hasVariants && variants.some((v) => !isCurrentLang(v));
  const rowLabels = variantRowLabels(variants);
  const displayedVariants =
    showAllLanguages || variantsInCurrentLanguage.length === 0
      ? variants
      : variantsInCurrentLanguage;

  const fetchSessions = useCallback(async (showSpinner = true) => {
    if (deleteLockRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    if (showSpinner) {
      setLoadingSessions(true);
    }
    try {
      const params = hasVariants && world.languageGroupId
        ? `languageGroupId=${encodeURIComponent(world.languageGroupId)}`
        : `worldId=${encodeURIComponent(world.id)}`;
      const res = await fetch(`${apiBase}/api/sessions?${params}`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (res.ok) {
        const { data } = await res.json();
        const nextSessions = data ?? [];
        if (controller.signal.aborted) return;
        setCachedSessions(userId, cacheKey, nextSessions);
        setSessions(nextSessions);
      }
    } catch {
      // silent
    } finally {
      if (!controller.signal.aborted) setLoadingSessions(false);
    }
  }, [cacheKey, hasVariants, userId, world.id, world.languageGroupId]);

  useEffect(() => {
    scopeRef.current += 1;
    if (open) {
      const cached = getCachedSessions<SessionItem>(userId, cacheKey);
      if (cached) {
        setSessions(cached);
        setLoadingSessions(false);
        void fetchSessions(false);
      } else {
        setSessions([]);
        void fetchSessions(true);
      }
      setRenamingId(null);
      setConfirmDeleteId(null);
      setShowVersionPicker(false);
      setNewSessionVersionId(world.id);
      setShowAllLanguages(false);
      setSelecting(false);
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
    }
    return () => { fetchControllerRef.current?.abort(); scopeRef.current += 1; };
  }, [cacheKey, open, fetchSessions, userId, world.id]);

  useEffect(() => {
    if (open && !deletingSelected && deletingId === null && refreshPendingRef.current) {
      refreshPendingRef.current = false;
      void fetchSessions(false);
    }
  }, [open, deletingSelected, deletingId, fetchSessions]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (deleteLockRef.current) return;
        if (renamingId) {
          setRenamingId(null);
        } else if (confirmBulkDelete) {
          setConfirmBulkDelete(false);
        } else if (selecting) {
          setSelecting(false);
          setSelectedIds(new Set());
        } else if (showVersionPicker) {
          setShowVersionPicker(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, renamingId, showVersionPicker, confirmBulkDelete, selecting]);

  useEffect(() => {
    if (open) contentRef.current?.focus();
  }, [open]);

  const selectedSessions = sessions.filter((session) => selectedIds.has(session.id));
  const allSelected = sessions.length > 0 && selectedSessions.length === sessions.length;
  const mutationBlocked = deletingSelected || deletingId !== null || !!creating;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedSessions.length > 0 && !allSelected;
    }
  }, [allSelected, selectedSessions.length, open, loadingSessions, selecting]);

  const toggleSelected = (sessionId: string) => {
    if (deleteLockRef.current || mutationBlocked) return;
    setRenamingId(null);
    setConfirmDeleteId(null);
    setConfirmBulkDelete(false);
    setShowVersionPicker(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    if (deleteLockRef.current || mutationBlocked || selectedSessions.length === 0) return;
    deleteLockRef.current = true;
    setDeletingSelected(true);
    fetchControllerRef.current?.abort();
    setLoadingSessions(false);
    const scope = scopeRef.current;
    const deleted = new Set<string>();
    const failed = new Set<string>();
    try {
      // Bound concurrency so selecting hundreds of saves does not flood the API.
      for (let offset = 0; offset < selectedSessions.length; offset += 4) {
        await Promise.all(selectedSessions.slice(offset, offset + 4).map(async (session) => {
          try {
            const res = await fetch(`${apiBase}/api/sessions/${session.id}`, {
              method: "DELETE", credentials: "include",
            });
            if (res.ok || res.status === 404) deleted.add(session.id);
            else failed.add(session.id);
          } catch {
            failed.add(session.id);
          }
        }));
      }
      const remaining = sessions.filter((session) => !deleted.has(session.id));
      setCachedSessions(userId, cacheKey, remaining);
      if (scope !== scopeRef.current) return;
      setSessions(remaining);
      setSelectedIds(failed);
      if (failed.size === 0) setSelecting(false);
      if (failed.size > 0) {
        feedback.error(t("header.bulkDeleteFailed", { count: failed.size }));
      }
    } finally {
      deleteLockRef.current = false;
      setDeletingSelected(false);
      setConfirmBulkDelete(false);
    }
  };

  // All sessions shown — no filtering by variant
  const sessionOrdinalMap = new Map(
    sessions
      .slice()
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
      .map((session, index) => [session.id, index + 1])
  );

  const startRename = (session: SessionItem) => {
    setRenamingId(session.id);
    setRenameValue(session.name ?? "");
    setConfirmDeleteId(null);
    window.setTimeout(() => renameInputRef.current?.select(), 0);
  };

  // Optimistic: the row shows the new name immediately, so success is silent.
  // A failure rolls the list back, which needs a pill with the name in hand.
  const applyRename = async (sessionId: string, trimmed: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId ? { ...session, name: trimmed || null } : session
      )
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
    } catch {
      await fetchSessions();
      feedback.error(t("feedback.renameFailed"), {
        label: t("common:action.retry"),
        onClick: () => void applyRename(sessionId, trimmed),
      });
    }
  };

  const submitRename = (sessionId: string) => void applyRename(sessionId, renameValue.trim().slice(0, 100));

  const handleDelete = async (sessionId: string) => {
    if (deleteLockRef.current || mutationBlocked) return;
    deleteLockRef.current = true;
    fetchControllerRef.current?.abort();
    setLoadingSessions(false);
    const scope = scopeRef.current;
    setDeletingId(sessionId);
    const fail = () =>
      feedback.error(t("feedback.sessionDeleteFailed"), {
        label: t("common:action.retry"),
        onClick: () => void handleDelete(sessionId),
      });
    try {
      const res = await fetch(`${apiBase}/api/sessions/${sessionId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        if (scope !== scopeRef.current) return;
        fail();
        return;
      }
      setCachedSessions(userId, cacheKey, sessions.filter((session) => session.id !== sessionId));
      if (scope !== scopeRef.current) return;
      // The row leaves the list — that is the confirmation.
      setSessions((prev) => prev.filter((session) => session.id !== sessionId));
    } catch {
      if (scope === scopeRef.current) fail();
    } finally {
      deleteLockRef.current = false;
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  // Only one version in the reader's language (the other variants are
  // translations they did not ask for): start it — the chooser used to
  // expand with that single option and take a second click.
  const onlyCurrentLanguageVersion = soleCurrentLanguageVariant(variants, i18n.language);

  const handleNewSessionClick = () => {
    if (deleteLockRef.current) return;
    if (usePersonasStore.getState().savingSelection || usePersonasStore.getState().selectionFailed) return;
    if (hasVariants && onlyCurrentLanguageVersion) {
      onCreateSession(onlyCurrentLanguageVersion.id);
      return;
    }
    if (hasVariants) {
      setShowVersionPicker((prev) => {
        if (!prev) {
          setShowAllLanguages(false);
          const initialList =
            variantsInCurrentLanguage.length > 0 ? variantsInCurrentLanguage : variants;
          const entryMatch = initialList.find((v) => v.id === world.id);
          setNewSessionVersionId(entryMatch?.id ?? initialList[0]?.id ?? world.id);
        }
        return !prev;
      });
    } else {
      onCreateSession(world.id);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div
        className={SESSION_MODAL_BACKDROP_CLASS}
        onClick={() => { if (!deleteLockRef.current) onClose(); }}
      />

      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("header.sessions")}
        tabIndex={-1}
        className={`${SESSION_MODAL_SURFACE_CLASS} max-w-[28rem]`}
      >
        <div className="flex items-center justify-between px-5 pb-4 pt-5">
          <div>
            <h2 className="text-[0.95rem] font-semibold text-foreground">{world.name}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {(sessions.length > 0 || selecting) && (
              <button
                type="button"
                disabled={mutationBlocked || loadingSessions}
                aria-pressed={selecting}
                onClick={() => {
                  if (deleteLockRef.current) return;
                  setSelecting((prev) => !prev);
                  setSelectedIds(new Set());
                  setRenamingId(null);
                  setConfirmDeleteId(null);
                  setConfirmBulkDelete(false);
                  setShowVersionPicker(false);
                }}
                className="mr-1 rounded-lg px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
              >
                {t(selecting ? "header.finishSelectingSessions" : "header.selectSessions")}
              </button>
            )}
            {/* Per-world persona pin — only rendered for users who have personas */}
            <WorldPersonaIconMenu worldId={showVersionPicker ? newSessionVersionId : world.id} disabled={mutationBlocked} />
            <button
              type="button"
              onClick={onClose}
              disabled={deletingSelected || deletingId !== null}
              aria-label={t("common:action.close")}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-muted-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mx-5 h-px bg-white/[0.06]" />

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {loadingSessions ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
            </div>
          ) : sessions.length > 0 ? (
            <div className={`${SESSION_MODAL_GROUP_CLASS} space-y-1.5 p-1.5`}>
              {sessions.map((session) => {
                const isRenaming = renamingId === session.id;
                const isConfirming = confirmDeleteId === session.id;
                const isDeleting = deletingId === session.id;
                const displayName =
                  session.name?.trim() || t("header.sessionOrdinal", { n: sessionOrdinalMap.get(session.id) ?? 1 });
                const badge = hasVariants ? versionBadgeText(session, variants) : null;

                if (isRenaming) {
                  return (
                    <div
                      key={session.id}
                      className="rounded-xl border border-primary/20 bg-primary/[0.03] px-3.5 py-3"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                            if (event.key === "Enter") submitRename(session.id);
                            if (event.key === "Escape") setRenamingId(null);
                          }}
                          maxLength={100}
                          placeholder={t("header.sessionName")}
                          className="h-8 flex-1 rounded-lg border border-white/[0.08] bg-black/20 px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-primary/40"
                        />
                        <button
                          onClick={() => submitRename(session.id)}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors hover:bg-primary/20"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setRenamingId(null)}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-muted-foreground transition-colors hover:bg-white/[0.08]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={session.id}
                    className={`group rounded-xl border px-3.5 py-3 transition-all hover:border-white/[0.06] hover:bg-white/[0.02] ${
                      selectedIds.has(session.id) ? "border-primary/20 bg-primary/[0.06]" : "border-transparent"
                    } ${!isConfirming && !mutationBlocked ? "cursor-pointer" : ""}`}
                    onClick={() => {
                      if (isConfirming || deleteLockRef.current || mutationBlocked) return;
                      if (selecting) toggleSelected(session.id);
                      else onSelectSession(session.id);
                    }}
                  >
                    <div className="flex items-center gap-2">
                      {selecting && (
                        <label className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-white/5" onClick={(event) => event.stopPropagation()}>
                          <input type="checkbox" checked={selectedIds.has(session.id)} disabled={mutationBlocked} aria-label={t("header.selectSession", { name: displayName })} onChange={() => toggleSelected(session.id)} className="h-4 w-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" />
                        </label>
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
                        {displayName}
                      </span>
                      {badge && (
                        <span className="shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground/60">
                          {badge}
                        </span>
                      )}
                      <div
                        className="session-row-actions touch-reveal flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => startRename(session)}
                          disabled={mutationBlocked || selecting}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:bg-white/[0.06] hover:text-foreground"
                          title={t("header.renameSession")}
                          aria-label={t("header.renameSession")}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(session.id)}
                          disabled={mutationBlocked || selecting}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                          title={t("header.deleteSession")}
                          aria-label={t("header.deleteSession")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[11px] text-muted-foreground/35">
                      <span className="flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" />
                        {session.messageCount}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {t("header.playedFor", { time: formatPlaytimeShort(session.playtimeSeconds, i18n.language) })}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatTimeAgo(session.updatedAt, i18n.language)}
                      </span>
                    </div>
                    {session.lastMessagePreview && (
                      <p className="mt-1 truncate text-xs text-muted-foreground/25 italic">
                        {session.lastMessagePreview}
                      </p>
                    )}

                    {isConfirming && (
                      <div
                        className="mt-2.5 flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/[0.04] px-3 py-2"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span className="flex-1 text-xs text-destructive/80">
                          {t("header.deleteConfirm")}
                        </span>
                        <button
                          onClick={() => void handleDelete(session.id)}
                          disabled={isDeleting}
                          className="rounded-lg bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
                        >
                          {isDeleting ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            t("header.yes")
                          )}
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-lg bg-white/[0.06] px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.1]"
                        >
                          {t("header.no")}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center py-12 text-muted-foreground/30">
              <MessageSquare className="mb-2 h-8 w-8" />
              <p className="text-sm">{t("header.noSessions")}</p>
            </div>
          )}
        </div>

        <div className="mx-5 h-px bg-white/[0.06]" />
        <div className="px-4 py-3.5">
          {selecting && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-foreground/90">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  disabled={mutationBlocked || sessions.length === 0}
                  aria-label={t("header.selectAllSessions")}
                  onChange={() => {
                    if (deleteLockRef.current) return;
                    setSelectedIds(allSelected ? new Set() : new Set(sessions.map((session) => session.id)));
                    setRenamingId(null);
                    setConfirmDeleteId(null);
                    setConfirmBulkDelete(false);
                    setShowVersionPicker(false);
                  }}
                  className="h-4 w-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
                {t(allSelected ? "header.deselectAllSessions" : "header.selectAllSessions")}
              </label>
              {selectedSessions.length > 0 && (
                <button
                  type="button"
                  disabled={mutationBlocked}
                  onClick={() => setConfirmBulkDelete(true)}
                  className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                >
                  {deletingSelected ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {t("header.deleteSelectedSessions", { count: selectedSessions.length })}
                </button>
              )}
            </div>
          )}

          {confirmBulkDelete && (
            <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/[0.04] p-3">
              <p role="alert" className="text-sm text-foreground">
                {t("header.bulkDeleteConfirm", { count: selectedSessions.length })}
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" disabled={deletingSelected} onClick={() => setConfirmBulkDelete(false)} className="min-h-11 rounded-lg px-3 text-sm text-foreground transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
                  {t("common:action.cancel")}
                </button>
                <button type="button" disabled={mutationBlocked} onClick={() => void handleBulkDelete()} className="flex min-h-11 items-center gap-2 rounded-lg bg-destructive px-3 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
                  {deletingSelected && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("common:action.delete")}
                </button>
              </div>
            </div>
          )}
          {/* Inline version picker — expands above the button */}
          {showVersionPicker && hasVariants && (
            <div className="mb-3 space-y-1">
              <div className="mb-2 flex items-center justify-between px-0.5">
                <p className="text-[11px] font-medium text-muted-foreground/70">
                  {t("header.chooseVersion")}
                </p>
                {hasOtherLanguageVariants && (
                  <button
                    type="button"
                    onClick={() => setShowAllLanguages((prev) => !prev)}
                    title={t(
                      showAllLanguages
                        ? "header.showCurrentLanguage"
                        : "header.showAllLanguages"
                    )}
                    aria-label={t(
                      showAllLanguages
                        ? "header.showCurrentLanguage"
                        : "header.showAllLanguages"
                    )}
                    aria-pressed={showAllLanguages}
                    className={`flex h-5 w-5 items-center justify-center rounded-md transition-colors ${
                      showAllLanguages
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground/40 hover:bg-white/[0.04] hover:text-muted-foreground/70"
                    }`}
                  >
                    <Globe className="h-3 w-3" />
                  </button>
                )}
              </div>
              {displayedVariants.map((variant) => {
                const label = rowLabels.get(variant.id) ?? variant.name;
                const langShort = variant.language
                  ? (LANGUAGE_SHORT[variant.language] ?? null)
                  : null;
                const isSelected = variant.id === newSessionVersionId;

                return (
                  <button
                    key={variant.id}
                    type="button"
                    onClick={() => setNewSessionVersionId(variant.id)}
                    disabled={creating || selectionBlocked}
                    className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm transition-all disabled:opacity-50 ${
                      isSelected
                        ? "border border-primary/20 bg-primary/[0.06] text-foreground"
                        : "border border-transparent text-muted-foreground/60 hover:border-white/[0.06] hover:bg-white/[0.02] hover:text-foreground"
                    }`}
                  >
                    <div
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                        isSelected ? "border-primary" : "border-muted-foreground/30"
                      }`}
                    >
                      {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
                    </div>
                    <span className="flex-1 font-medium">{label}</span>
                    {langShort && (
                      <span className="shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground/50">
                        {langShort}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {!selecting && <button
            type="button"
            onClick={showVersionPicker ? () => {
              if (usePersonasStore.getState().savingSelection || usePersonasStore.getState().selectionFailed) return;
              setShowVersionPicker(false); onCreateSession(newSessionVersionId);
            } : handleNewSessionClick}
            disabled={creating || selectionBlocked || deletingSelected || deletingId !== null}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary/90 px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {showVersionPicker ? t("header.startThisVersion") : t("header.newSession")}
          </button>}
          {selectionBlocked && <p role="status" className="mt-2 text-sm text-muted-foreground">{tProfile(selectionFailed ? "persona.session.creationBlocked" : "persona.session.waitSelection")}</p>}
          {showVersionPicker && (
            <button
              type="button"
              onClick={() => setShowVersionPicker(false)}
              disabled={creating}
              className="mt-2 w-full rounded-lg py-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-50"
            >
              {t("common:action.cancel")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export const SessionPickerModal = memo(SessionPickerModalImpl);
