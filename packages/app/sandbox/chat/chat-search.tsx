// Chat-history search: find an old part of a long story without scrolling for
// it. Opened from the composer's "+" menu or the play-controls bar (both reach
// ChatSearchHostMount in component-host). Searches the whole session on the
// server; picking a hit loads the pages up to it and scrolls the transcript
// there. A card whose interface draws no platform transcript has nowhere to
// scroll, so there the hit opens in place, with the same "Remember this".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pin, Search, X } from "lucide-react";
import { JUMP_TO_MESSAGE_EVENT, OPEN_AT_MESSAGE_EVENT, OPEN_CHAT_SEARCH_EVENT, useYumina, type ChatSearchHit } from "../sandbox-context";
import { SandboxPlatformOverlay } from "../platform-overlay-portal";
import { makeChatT } from "./i18n";
import { isTranscriptMounted } from "./player-prompts";
import { rememberInPinnedNotes } from "./core-memory";
import { loadUntilMessage, splitHighlight, waitForPage, type HistoryWindowState } from "./search-jump";

interface SearchState {
  query: string;
  hits: ChatSearchHit[];
  hasMore: boolean;
  status: "idle" | "loading" | "done" | "error";
  loadingMore: boolean;
}

const EMPTY: SearchState = { query: "", hits: [], hasMore: false, status: "idle", loadingMore: false };
const DEBOUNCE_MS = 300;

/** The last search of each session, so reopening after a jump shows the same
 *  hits: the first one picked is often not the right one. */
const lastSearch = new Map<string, SearchState>();

function normalize(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function Snippet({ hit, query }: { hit: ChatSearchHit; query: string }) {
  const parts = useMemo(() => splitHighlight(hit.snippet, query), [hit.snippet, query]);
  return (
    <>
      {hit.clippedStart && "…"}
      {parts.map((part, i) => part.hit
        ? <mark key={i} className="bg-transparent font-semibold text-primary">{part.text}</mark>
        : <span key={i}>{part.text}</span>)}
      {hit.clippedEnd && "…"}
    </>
  );
}

export function ChatSearchPanel({ open, onClose, initialQuery }: { open: boolean; onClose: () => void; initialQuery?: string }) {
  const api = useYumina();
  const apiRef = useRef(api);
  apiRef.current = api;
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const sessionId = api.sessionId ?? "";
  const [state, setState] = useState<SearchState>(() => {
    const last = lastSearch.get(sessionId);
    return initialQuery && last?.query !== normalize(initialQuery) ? EMPTY : last ?? EMPTY;
  });
  const [input, setInput] = useState(initialQuery ?? state.query);
  const [opening, setOpening] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [remembering, setRemembering] = useState(false);
  const requestRef = useRef(0);
  const openAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (sessionId) lastSearch.set(sessionId, state); }, [sessionId, state]);
  useEffect(() => () => openAbortRef.current?.abort(), []);

  const runSearch = useCallback(async (query: string, before?: number) => {
    const token = ++requestRef.current;
    if (!query) { setState(EMPTY); return; }
    setState((prev) => before
      ? { ...prev, loadingMore: true }
      : { ...prev, query, status: "loading", loadingMore: false });
    try {
      const result = await apiRef.current.searchMessages(query, before ? { before } : undefined);
      if (token !== requestRef.current) return;
      setState((prev) => ({
        query,
        hits: before ? [...prev.hits, ...result.hits] : result.hits,
        hasMore: result.hasMore,
        status: "done",
        loadingMore: false,
      }));
    } catch {
      if (token !== requestRef.current) return;
      setState((prev) => before ? { ...prev, loadingMore: false } : { ...prev, query, hits: [], hasMore: false, status: "error" });
    }
  }, []);

  // Search as the player types, once they pause.
  useEffect(() => {
    if (!open) return;
    const query = normalize(input);
    if (query === state.query && state.status !== "error") return;
    const timer = window.setTimeout(() => { void runSearch(query); }, query ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, open, runSearch]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const windowState = useCallback((): HistoryWindowState => {
    const live = apiRef.current;
    return {
      sessionId: live.sessionId ?? "",
      messages: live.messages as readonly { id?: unknown }[],
      hasEarlierMessages: live.hasEarlierMessages,
      isLoadingEarlier: live.isLoadingEarlier,
      firstMessageNumber: live.firstMessageNumber,
    };
  }, []);

  const pick = async (hit: ChatSearchHit) => {
    if (opening) return;
    if (expanded === hit.id) { setExpanded(null); return; }
    openAbortRef.current?.abort();
    const controller = new AbortController();
    openAbortRef.current = controller;
    setOpening(hit.id);
    try {
      const loaded = await loadUntilMessage({
        messageId: hit.id,
        position: hit.position,
        current: windowState,
        load: () => apiRef.current.loadEarlierMessages(),
        committed: (previous) => waitForPage(windowState, previous),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!loaded) { apiRef.current.showToast(t("searchOpenFailed"), "error"); return; }
      if (isTranscriptMounted()) {
        onClose();
        window.dispatchEvent(new CustomEvent(JUMP_TO_MESSAGE_EVENT, { detail: { messageId: hit.id } }));
      } else {
        setExpanded(hit.id);
      }
    } finally {
      if (openAbortRef.current === controller) setOpening(null);
    }
  };

  // Same rule as the message's own pin: the selected sentences, or the whole
  // of a short message.
  const remember = async (content: string) => {
    if (remembering) return;
    const selected = window.getSelection()?.toString().trim() ?? "";
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const fromThis = selected && flat(content).includes(flat(selected));
    const text = fromThis ? selected : content.trim();
    if (!fromThis && text.length > 800) { api.showToast(t("rememberTooLong"), "info"); return; }
    setRemembering(true);
    try {
      const result = await rememberInPinnedNotes(api, text);
      if (result === "saved") api.showToast(t("remembered"), "success");
      else if (result === "too-long") api.showToast(t("rememberFull"), "error");
    } catch {
      api.showToast(t("rememberFailed"), "error");
    } finally {
      setRemembering(false);
    }
  };

  if (!open) return null;
  const query = normalize(input);
  // While a new query is on its way the previous hits stay up (spinner in the field).
  const showResults = query.length > 0 && (state.hits.length > 0 || state.status === "done" || state.status === "error");
  const expandedMessage = expanded
    ? (api.messages as unknown as Array<{ id: string; content: string }>).find((m) => m.id === expanded)
    : null;

  return (
    <SandboxPlatformOverlay>
      <div
        className="fixed inset-0 z-[9999] flex items-start justify-center px-2 pt-[calc(env(safe-area-inset-top,0px)+3.5rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={t("searchMessages")}
      >
        <div className="absolute inset-0 modal-backdrop" />
        <div
          data-chat-search=""
          onClick={(e) => e.stopPropagation()}
          className="relative z-10 flex max-h-[min(640px,calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-5rem))] w-[min(560px,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#17181b]/95 shadow-2xl shadow-black/45 backdrop-blur-xl"
        >
          <div className="flex shrink-0 items-center gap-2.5 p-2">
            <div className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-white/[0.07] pl-4 pr-3">
              <Search className="h-4 w-4 shrink-0 text-white/40" aria-hidden="true" />
              <input
                ref={inputRef}
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                enterKeyHint="search"
                maxLength={200}
                placeholder={t("searchMessages")}
                aria-label={t("searchMessages")}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-white outline-none placeholder:text-white/40"
              />
              {state.status === "loading" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/40" aria-label={t("searching")} />}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/5 hover:text-white/75"
              title={t("cancel")}
              aria-label={t("cancel")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {showResults && (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-white/[0.06] p-1.5" role="list">
              {state.status === "error" ? (
                <button type="button" onClick={() => void runSearch(query)} className="w-full px-3 py-3 text-left text-[13px] text-rose-300/90 hover:text-rose-200">
                  {t("searchFailed")}
                </button>
              ) : state.status === "done" && state.hits.length === 0 ? (
                <p className="px-3 py-3 text-[13px] text-white/45">{t("noMatchingMessages")}</p>
              ) : (
                state.hits.map((hit) => (
                  <div key={hit.id} role="listitem">
                    <button
                      type="button"
                      data-search-hit={hit.position}
                      onClick={() => void pick(hit)}
                      aria-expanded={expanded === hit.id ? true : undefined}
                      className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05] focus-visible:bg-white/[0.06] focus-visible:outline-none"
                    >
                      <span className={`min-w-[2.75rem] shrink-0 pt-px text-right text-[11.5px] tabular-nums ${hit.role === "user" ? "text-emerald-300/60" : "text-primary/70"}`}>
                        #{hit.position}
                      </span>
                      {/* Opened in place, the whole message replaces the snippet below. */}
                      <span className="line-clamp-3 min-w-0 flex-1 break-words text-[13px] leading-relaxed text-white/75">
                        {!(expanded === hit.id && expandedMessage) && <Snippet hit={hit} query={state.query} />}
                      </span>
                      {opening === hit.id && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-white/45" />}
                    </button>
                    {expanded === hit.id && expandedMessage && (
                      <div className="-mt-8 mb-1.5 ml-[4.25rem] mr-3 space-y-2">
                        <p className="max-h-60 select-text overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-white/85">
                          <Snippet hit={{ ...hit, snippet: expandedMessage.content, clippedStart: false, clippedEnd: false }} query={state.query} />
                        </p>
                        <button
                          type="button"
                          disabled={remembering}
                          onClick={() => void remember(expandedMessage.content)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.14] px-2.5 py-1 text-[12px] text-white/80 transition-colors hover:border-primary/50 hover:text-white disabled:opacity-40"
                        >
                          {remembering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pin className="h-3 w-3" />}
                          {t("rememberThis")}
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
              {state.status === "done" && state.hasMore && (
                <button
                  type="button"
                  disabled={state.loadingMore}
                  onClick={() => void runSearch(state.query, state.hits.at(-1)?.position)}
                  className="flex min-h-10 w-full items-center justify-center gap-2 px-3 py-2 text-[12.5px] text-white/50 transition-colors hover:text-white/80 disabled:opacity-60"
                >
                  {state.loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t("loadEarlier")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </SandboxPlatformOverlay>
  );
}

/**
 * Open the session on screen at one message, loaded or not: the save picker's
 * search picks a hit in a save, the save opens, and this finishes the trip —
 * the same page loading and scroll as picking a hit here. Waits until the
 * requested session is the one on screen with its history in. A card that
 * draws no platform transcript gets the search panel with that query instead.
 */
export function OpenAtMessageHost() {
  const api = useYumina();
  const apiRef = useRef(api);
  apiRef.current = api;
  const [request, setRequest] = useState<{ sessionId: string; messageId: string; position: number; query: string; at: number } | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown; messageId?: unknown; position?: unknown; query?: unknown }>).detail;
      if (typeof detail?.sessionId !== "string" || typeof detail.messageId !== "string") return;
      setRequest({
        sessionId: detail.sessionId,
        messageId: detail.messageId,
        position: Math.max(1, Math.floor(Number(detail.position) || 1)),
        query: typeof detail.query === "string" ? detail.query : "",
        at: Date.now(),
      });
    };
    window.addEventListener(OPEN_AT_MESSAGE_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_AT_MESSAGE_EVENT, onRequest);
  }, []);

  useEffect(() => {
    if (!request || runningRef.current) return;
    // The session never showed up (navigation failed or went elsewhere).
    if (Date.now() - request.at > 30_000) { setRequest(null); return; }
    if (api.sessionId !== request.sessionId || api.messages.length === 0) return;
    runningRef.current = true;
    const target = request;
    const windowState = (): HistoryWindowState => {
      const live = apiRef.current;
      return {
        sessionId: live.sessionId ?? "",
        messages: live.messages as readonly { id?: unknown }[],
        hasEarlierMessages: live.hasEarlierMessages,
        isLoadingEarlier: live.isLoadingEarlier,
        firstMessageNumber: live.firstMessageNumber,
      };
    };
    void (async () => {
      try {
        // Let the transcript mount with the first page before scrolling it.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const loaded = await loadUntilMessage({
          messageId: target.messageId,
          position: target.position,
          current: windowState,
          load: () => apiRef.current.loadEarlierMessages(),
          committed: (previous) => waitForPage(windowState, previous),
        });
        if (apiRef.current.sessionId !== target.sessionId) return;
        if (!loaded) {
          apiRef.current.showToast(makeChatT(apiRef.current.language)("searchOpenFailed"), "error");
        } else if (isTranscriptMounted()) {
          window.dispatchEvent(new CustomEvent(JUMP_TO_MESSAGE_EVENT, { detail: { messageId: target.messageId } }));
        } else if (target.query) {
          window.dispatchEvent(new CustomEvent(OPEN_CHAT_SEARCH_EVENT, { detail: { query: target.query } }));
        }
      } finally {
        runningRef.current = false;
        setRequest((current) => current === target ? null : current);
      }
    })();
  }, [api, request]);

  return null;
}
