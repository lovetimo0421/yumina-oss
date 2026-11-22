import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
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
  Search,
  Star,
  ArrowUpDown,
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
import { getCachedSessions, setCachedSessions } from "@/lib/session-picker-cache";
import { WorldPersonaIconMenu } from "@/features/chat/world-persona-menu";
import { usePersonasStore } from "@/stores/personas";
import { requestMessageJump } from "../lib/pending-message-jump";
import { splitHighlight } from "../../sandbox/chat/search-jump";
import {
  SAVE_PAGE,
  SAVE_SEARCH_MIN,
  SAVE_SORTS,
  matchesSaveLocally,
  normalizeSaveQuery,
  orderSaves,
  readSaveSort,
  writeSaveSort,
  type SaveSort,
} from "./session-picker-list";

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
  /** A line that tells an unnamed save apart (its recap, or the player's opening). */
  subtitle?: string | null;
  pinnedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One message hit, as GET /api/sessions/search and /:id/messages/search return it. */
interface SaveHit {
  id: string;
  role: "user" | "assistant" | "system";
  position: number;
  snippet: string;
  clippedStart: boolean;
  clippedEnd: boolean;
}

interface SaveMatch {
  sessionId: string;
  hitCount: number;
  hits: SaveHit[];
}

interface ServerSearch {
  /** The query being (or last) asked. */
  query: string;
  status: "loading" | "done" | "error";
  /** Results, and the query they answer (the previous one while loading). */
  matches: Map<string, SaveMatch>;
  matchesFor: string;
}

/** Hits of one save past the first few, paged from the per-save search. */
interface MoreHits {
  hits: SaveHit[];
  hasMore: boolean;
  loading: boolean;
}

const SEARCH_DEBOUNCE_MS = 300;
const MORE_HITS_PAGE = 10;

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  return (
    <>
      {splitHighlight(text, query).map((part, index) => part.hit
        ? <mark key={index} className="bg-transparent font-semibold text-primary">{part.text}</mark>
        : <span key={index}>{part.text}</span>)}
    </>
  );
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchControllerRef = useRef<AbortController | null>(null);
  const searchCacheRef = useRef(new Map<string, Map<string, SaveMatch>>());
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
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
  const [query, setQuery] = useState("");
  // The search bar (with sort) opens from the header magnifier or Ctrl/Cmd+F.
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState<ServerSearch | null>(null);
  const [moreHits, setMoreHits] = useState<Record<string, MoreHits>>({});
  const [sort, setSort] = useState<SaveSort>(() => readSaveSort(userId));
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(SAVE_PAGE);
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
  // All languages: the reader's own first, then the translations.
  const displayedVariants =
    showAllLanguages || variantsInCurrentLanguage.length === 0
      ? [...variantsInCurrentLanguage, ...variants.filter((v) => !isCurrentLang(v))]
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
      setQuery("");
      setSearchOpen(false);
      setSearch(null);
      setMoreHits({});
      setSortMenuOpen(false);
      setVisibleCount(SAVE_PAGE);
      setSort(readSaveSort(userId));
      searchCacheRef.current = new Map();
    }
    return () => {
      fetchControllerRef.current?.abort();
      searchControllerRef.current?.abort();
      scopeRef.current += 1;
    };
  }, [cacheKey, open, fetchSessions, userId, world.id]);

  // ── Search: the list filters as the player types (name, recap line, last
  // message); after a pause the server searches every message of these saves.
  const normalizedQuery = normalizeSaveQuery(query);
  const searchAvailable = sessions.length >= SAVE_SEARCH_MIN;
  // Hiding the bar drops the search with it: no filter works out of sight.
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    setSortMenuOpen(false);
  };
  const scopeParam = hasVariants && world.languageGroupId
    ? `languageGroupId=${encodeURIComponent(world.languageGroupId)}`
    : `worldId=${encodeURIComponent(world.id)}`;

  const runSearch = useCallback(async (q: string) => {
    searchControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    setSearch((prev) => ({
      query: q,
      status: "loading",
      matches: prev?.matches ?? new Map(),
      matchesFor: prev?.matchesFor ?? "",
    }));
    try {
      const res = await fetch(`${apiBase}/api/sessions/search?${scopeParam}&q=${encodeURIComponent(q)}`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = await res.json() as { data?: SaveMatch[] };
      if (controller.signal.aborted) return;
      const matches = new Map((data ?? []).map((match) => [match.sessionId, match]));
      searchCacheRef.current.set(q, matches);
      setSearch({ query: q, status: "done", matches, matchesFor: q });
    } catch {
      if (controller.signal.aborted) return;
      setSearch((prev) => prev && prev.query === q ? { ...prev, status: "error" } : prev);
    }
  }, [scopeParam]);

  useEffect(() => {
    if (!open) return;
    setMoreHits({});
    setVisibleCount(SAVE_PAGE);
    if (!normalizedQuery) {
      searchControllerRef.current?.abort();
      setSearch(null);
      return;
    }
    const cached = searchCacheRef.current.get(normalizedQuery);
    if (cached) {
      searchControllerRef.current?.abort();
      setSearch({ query: normalizedQuery, status: "done", matches: cached, matchesFor: normalizedQuery });
      return;
    }
    const timer = window.setTimeout(() => void runSearch(normalizedQuery), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, normalizedQuery, runSearch]);

  useEffect(() => { setVisibleCount(SAVE_PAGE); }, [sort]);

  useEffect(() => {
    if (!sortMenuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!sortMenuRef.current?.contains(event.target as Node)) setSortMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [sortMenuOpen]);

  useEffect(() => {
    if (open && !deletingSelected && deletingId === null && refreshPendingRef.current) {
      refreshPendingRef.current = false;
      void fetchSessions(false);
    }
  }, [open, deletingSelected, deletingId, fetchSessions]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      // Ctrl/Cmd+F searches the saves, not the page behind the dialog.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && (searchAvailable || searchOpen)) {
        event.preventDefault();
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select();
        } else {
          setSearchOpen(true); // focused once it renders
        }
        return;
      }
      if (event.key === "Escape") {
        if (deleteLockRef.current) return;
        if (sortMenuOpen) {
          setSortMenuOpen(false);
        } else if (renamingId) {
          setRenamingId(null);
        } else if (confirmBulkDelete) {
          setConfirmBulkDelete(false);
        } else if (query) {
          setQuery("");
        } else if (searchOpen) {
          setSearchOpen(false);
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
  }, [open, onClose, renamingId, showVersionPicker, confirmBulkDelete, selecting, query, sortMenuOpen, searchOpen, searchAvailable]);

  useEffect(() => {
    if (searchOpen && !loadingSessions) searchInputRef.current?.focus();
  }, [searchOpen, loadingSessions]);

  useEffect(() => {
    if (open) contentRef.current?.focus();
  }, [open]);

  // "Session N" by age, whatever order the list is in.
  const sessionOrdinalMap = useMemo(() => new Map(
    sessions
      .slice()
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
      .map((session, index) => [session.id, index + 1])
  ), [sessions]);
  const displayNameOf = useCallback((session: SessionItem) =>
    session.name?.trim() || t("header.sessionOrdinal", { n: sessionOrdinalMap.get(session.id) ?? 1 }),
  [sessionOrdinalMap, t]);

  const orderedSessions = useMemo(
    () => orderSaves(sessions, sort, displayNameOf, i18n.language),
    [sessions, sort, displayNameOf, i18n.language],
  );
  // Server results answer this exact query; while a longer query is on its
  // way, the previous (wider) results keep the list from flickering empty.
  const exactMatches = search && search.matchesFor === normalizedQuery ? search.matches : null;
  const rowMatches = exactMatches
    ?? (search && search.matchesFor && normalizedQuery.toLowerCase().includes(search.matchesFor.toLowerCase()) ? search.matches : null);
  const searching = normalizedQuery.length > 0;
  // No final answer for this query yet: waiting out the pause, or asking.
  const searchPending = searching && (search?.query !== normalizedQuery || search.status === "loading");
  const searchFailed = searching && search?.status === "error" && search.query === normalizedQuery;
  const visibleSessions = useMemo(() => {
    if (!searching) return orderedSessions;
    return orderedSessions.filter((session) =>
      rowMatches?.has(session.id) ||
      matchesSaveLocally([displayNameOf(session), session.subtitle, session.lastMessagePreview], normalizedQuery));
  }, [searching, orderedSessions, rowMatches, displayNameOf, normalizedQuery]);
  const renderedSessions = visibleSessions.slice(0, visibleCount);

  // Big lists render a page at a time; the next page joins near the bottom.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || visibleCount >= visibleSessions.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisibleCount((count) => count + SAVE_PAGE);
    }, { root: listRef.current, rootMargin: "400px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, visibleSessions.length]);

  // With a search on, "select all" means every matching save.
  const selectScope = searching ? visibleSessions : sessions;
  const selectedSessions = sessions.filter((session) => selectedIds.has(session.id));
  const allSelected = selectScope.length > 0 && selectScope.every((session) => selectedIds.has(session.id));
  const someSelectedInScope = selectScope.some((session) => selectedIds.has(session.id));
  const mutationBlocked = deletingSelected || deletingId !== null || !!creating;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelectedInScope && !allSelected;
    }
  }, [allSelected, someSelectedInScope, open, loadingSessions, selecting]);

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

  // Optimistic like rename: the star moves at once; a failure puts it back.
  const togglePin = async (session: SessionItem) => {
    if (mutationBlocked) return;
    const previous = session.pinnedAt ?? null;
    const pinned = !previous;
    const patch = (pinnedAt: string | null) => {
      setSessions((prev) => {
        const next = prev.map((row) => row.id === session.id ? { ...row, pinnedAt } : row);
        setCachedSessions(userId, cacheKey, next);
        return next;
      });
    };
    patch(pinned ? new Date().toISOString() : null);
    try {
      const res = await fetch(`${apiBase}/api/sessions/${session.id}/pin`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) throw new Error();
      const { data } = await res.json() as { data?: { pinnedAt?: string | null } };
      if (data && "pinnedAt" in data) patch(data.pinnedAt ?? null);
    } catch {
      patch(previous);
      feedback.error(t(pinned ? "header.pinFailed" : "header.unpinFailed"));
    }
  };

  // The save opens at that message: the chat loads up to it, scrolls there and
  // marks it, as picking a hit in the in-story search does.
  const openAtHit = (sessionId: string, hit: SaveHit) => {
    if (deleteLockRef.current || mutationBlocked) return;
    requestMessageJump({ sessionId, messageId: hit.id, position: hit.position, query: normalizedQuery });
    onSelectSession(sessionId);
  };

  const loadMoreHits = async (sessionId: string, shown: SaveHit[]) => {
    const q = normalizedQuery;
    if (!q || moreHits[sessionId]?.loading) return;
    setMoreHits((prev) => ({ ...prev, [sessionId]: { hits: prev[sessionId]?.hits ?? [], hasMore: true, loading: true } }));
    const params = new URLSearchParams({ q, limit: String(MORE_HITS_PAGE) });
    const last = shown.at(-1);
    if (last) params.set("before", String(last.position));
    try {
      const res = await fetch(`${apiBase}/api/sessions/${sessionId}/messages/search?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error();
      const json = await res.json() as { data?: SaveHit[]; meta?: { hasMore?: boolean } };
      if (normalizeSaveQuery(searchInputRef.current?.value ?? q) !== q) return;
      setMoreHits((prev) => {
        const known = new Set([...shown, ...(prev[sessionId]?.hits ?? [])].map((hit) => hit.id));
        const fresh = (json.data ?? []).filter((hit) => !known.has(hit.id));
        return { ...prev, [sessionId]: { hits: [...(prev[sessionId]?.hits ?? []), ...fresh], hasMore: !!json.meta?.hasMore, loading: false } };
      });
    } catch {
      setMoreHits((prev) => ({ ...prev, [sessionId]: { hits: prev[sessionId]?.hits ?? [], hasMore: true, loading: false } }));
      feedback.error(t("header.searchFailed"));
    }
  };

  const chooseSort = (next: SaveSort) => {
    setSort(next);
    writeSaveSort(userId, next);
    setSortMenuOpen(false);
  };

  const handleNewSessionClick = () => {
    if (deleteLockRef.current) return;
    if (usePersonasStore.getState().savingSelection || usePersonasStore.getState().selectionFailed) return;
    if (hasVariants) {
      // A card in several languages always asks which one, so the globe that reveals the other
      // languages is always within reach: starting the reader's-language version in one click
      // (2026-09-25) left no way to play another language but switching the whole site's
      // language (2026-11-02, Tsuna). The list itself opens on the reader's language only; the
      // other languages show when the globe is pressed (owner, 2026-11-05).
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
            {(searchAvailable || searchOpen) && !loadingSessions && (
              <button
                type="button"
                onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
                aria-pressed={searchOpen}
                aria-label={t("header.searchSaves")}
                title={t("header.searchSaves")}
                className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white/5 ${
                  searchOpen ? "text-primary" : "text-muted-foreground/40 hover:text-muted-foreground"
                }`}
              >
                <Search className="h-4 w-4" />
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

        {searchOpen && !loadingSessions && (
          <div className="flex items-center gap-1.5 px-3 pt-3">
            <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 pl-2.5 pr-1 focus-within:border-primary/40">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                enterKeyHint="search"
                maxLength={200}
                placeholder={t("header.searchSaves")}
                aria-label={t("header.searchSaves")}
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/35 [&::-webkit-search-cancel-button]:hidden"
              />
              {searchPending && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/40" aria-hidden="true" />}
              <button
                type="button"
                onClick={() => {
                  if (!query) { closeSearch(); return; }
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                aria-label={query ? t("header.clearSearch") : t("common:action.close")}
                title={query ? t("header.clearSearch") : t("common:action.close")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div ref={sortMenuRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => setSortMenuOpen((prev) => !prev)}
                aria-haspopup="menu"
                aria-expanded={sortMenuOpen}
                aria-label={t("header.sortSaves")}
                title={t("header.sortSaves")}
                className={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors hover:bg-white/[0.05] hover:text-foreground ${
                  sortMenuOpen ? "bg-white/[0.05] text-foreground" : "text-muted-foreground/70"
                }`}
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t(`header.sort.${sort}`)}</span>
              </button>
              {sortMenuOpen && (
                <div role="menu" className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] rounded-xl border border-white/[0.08] bg-[#22232a] p-1 shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
                  {SAVE_SORTS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sort === option}
                      onClick={() => chooseSort(option)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-white/[0.05] ${
                        sort === option ? "text-foreground" : "text-muted-foreground/70"
                      }`}
                    >
                      <span className="flex-1">{t(`header.sort.${option}`)}</span>
                      {sort === option && <Check className="h-3.5 w-3.5 text-primary" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3">
          {loadingSessions ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
            </div>
          ) : searching && visibleSessions.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-muted-foreground/40">
              {searchPending ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
              ) : searchFailed ? (
                <button type="button" onClick={() => void runSearch(normalizedQuery)} className="text-sm text-destructive/80 hover:text-destructive">
                  {t("header.searchFailed")}
                </button>
              ) : (
                <p className="text-sm">{t("header.noMatchingSaves")}</p>
              )}
            </div>
          ) : sessions.length > 0 ? (
            <div className={`${SESSION_MODAL_GROUP_CLASS} space-y-1.5 p-1.5`}>
              {renderedSessions.map((session) => {
                const isRenaming = renamingId === session.id;
                const isConfirming = confirmDeleteId === session.id;
                const isDeleting = deletingId === session.id;
                const displayName = displayNameOf(session);
                const badge = hasVariants ? versionBadgeText(session, variants) : null;
                const unnamed = !session.name?.trim();
                const match = searching ? exactMatches?.get(session.id) : undefined;
                const extra = match ? moreHits[session.id] : undefined;
                const hits = match ? [...match.hits, ...(extra?.hits ?? [])] : [];
                const remaining = match && extra?.hasMore !== false ? Math.max(0, match.hitCount - hits.length) : 0;
                const pinButton = (
                  <button
                    type="button"
                    onClick={() => void togglePin(session)}
                    disabled={mutationBlocked || selecting}
                    className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06] ${
                      session.pinnedAt ? "text-primary/80 hover:text-primary" : "text-muted-foreground/50 hover:text-foreground"
                    }`}
                    title={t(session.pinnedAt ? "header.unpinSession" : "header.pinSession")}
                    aria-label={t(session.pinnedAt ? "header.unpinSession" : "header.pinSession")}
                    aria-pressed={!!session.pinnedAt}
                  >
                    <Star className={`h-3 w-3 ${session.pinnedAt ? "fill-current" : ""}`} />
                  </button>
                );

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
                        <Highlight text={displayName} query={normalizedQuery} />
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
                        {!session.pinnedAt && pinButton}
                      </div>
                      {/* A pinned star stays in sight, in the same last slot. */}
                      {session.pinnedAt && (
                        <div className="session-row-actions -ml-1.5 flex shrink-0" onClick={(event) => event.stopPropagation()}>{pinButton}</div>
                      )}
                    </div>
                    {unnamed && session.subtitle && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground/55">
                        <Highlight text={session.subtitle} query={normalizedQuery} />
                      </p>
                    )}

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
                        <Highlight text={session.lastMessagePreview} query={normalizedQuery} />
                      </p>
                    )}

                    {match && (
                      <div className="mt-2 border-l border-white/[0.08] pl-2">
                        <p className="px-1.5 text-[11px] text-primary/70">
                          {t("header.searchHits", { count: match.hitCount })}
                        </p>
                        {hits.map((hit) => (
                          <button
                            key={hit.id}
                            type="button"
                            data-save-hit={hit.position}
                            onClick={(event) => {
                              if (selecting) return; // the row's own click selects
                              event.stopPropagation();
                              openAtHit(session.id, hit);
                            }}
                            className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]"
                          >
                            <span className={`min-w-[2.5rem] shrink-0 pt-px text-[11px] tabular-nums ${hit.role === "user" ? "text-emerald-300/60" : "text-muted-foreground/50"}`}>
                              #{hit.position}
                            </span>
                            <span className="line-clamp-2 min-w-0 flex-1 break-words text-xs leading-relaxed text-foreground/70">
                              {hit.clippedStart && "…"}
                              <Highlight text={hit.snippet} query={exactMatches ? normalizedQuery : ""} />
                              {hit.clippedEnd && "…"}
                            </span>
                          </button>
                        ))}
                        {remaining > 0 && (
                          <button
                            type="button"
                            disabled={extra?.loading}
                            onClick={(event) => {
                              event.stopPropagation();
                              void loadMoreHits(session.id, hits);
                            }}
                            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-60"
                          >
                            {extra?.loading && <Loader2 className="h-3 w-3 animate-spin" />}
                            {t("header.searchMore", { count: remaining })}
                          </button>
                        )}
                      </div>
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
              {renderedSessions.length < visibleSessions.length && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}
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
                  disabled={mutationBlocked || selectScope.length === 0 || searchPending}
                  aria-label={searching ? t("header.selectAllMatching", { count: selectScope.length }) : t("header.selectAllSessions")}
                  onChange={() => {
                    if (deleteLockRef.current) return;
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      for (const session of selectScope) {
                        if (allSelected) next.delete(session.id);
                        else next.add(session.id);
                      }
                      return next;
                    });
                    setRenamingId(null);
                    setConfirmDeleteId(null);
                    setConfirmBulkDelete(false);
                    setShowVersionPicker(false);
                  }}
                  className="h-4 w-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
                {searching
                  ? t(allSelected ? "header.deselectAllMatching" : "header.selectAllMatching", { count: selectScope.length })
                  : t(allSelected ? "header.deselectAllSessions" : "header.selectAllSessions")}
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
                    onClick={() => {
                      const next = !showAllLanguages;
                      setShowAllLanguages(next);
                      // Hiding the other languages must not leave a hidden version picked.
                      if (!next && variantsInCurrentLanguage.length > 0
                        && !variantsInCurrentLanguage.some((v) => v.id === newSessionVersionId)) {
                        setNewSessionVersionId(
                          (variantsInCurrentLanguage.find((v) => v.id === world.id) ?? variantsInCurrentLanguage[0]!).id,
                        );
                      }
                    }}
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
                        : "text-muted-foreground/70 hover:bg-white/[0.04] hover:text-foreground"
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
