import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Pencil, Plus } from "lucide-react";
import { fetchWorldUpdatePage, notifyPublishedWorldUpdate, subscribeToPublishedWorldUpdates, type WorldUpdateItem } from "./world-update-history-data";
import { WorldUpdateCreateDialog, WorldUpdateEditDialog } from "./world-update-edit-dialog";

interface UpdateHistoryState {
  worldId: string;
  updates: WorldUpdateItem[] | null;
  failed: boolean;
  hasMore: boolean;
  nextOffset: number | null;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  canEdit: boolean;
  canCreate: boolean;
  canNotify: boolean;
}

function emptyState(worldId: string): UpdateHistoryState {
  return {
    worldId,
    updates: null,
    failed: false,
    hasMore: false,
    nextOffset: null,
    loadingMore: false,
    loadMoreFailed: false,
    canEdit: false,
    canCreate: false,
    canNotify: false,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function WorldUpdateHistory({
  worldId,
  creatorName,
  canEdit = false,
  showCreateButton = false,
  heading,
}: {
  worldId: string;
  creatorName?: string | null;
  canEdit?: boolean;
  showCreateButton?: boolean;
  heading?: React.ReactNode;
}) {
  const { t, i18n } = useTranslation("library");
  const [result, setResult] = useState<UpdateHistoryState>(() => emptyState(worldId));
  const [requestVersion, setRequestVersion] = useState(0);
  const [editing, setEditing] = useState<{
    worldId: string;
    update: WorldUpdateItem;
    trigger: HTMLButtonElement;
  } | null>(null);
  const [savedWorldId, setSavedWorldId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ worldId: string; trigger: HTMLButtonElement } | null>(null);
  const [createdWorldId, setCreatedWorldId] = useState<string | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const historyMutationRef = useRef(0);
  const allowEdit = canEdit && result.worldId === worldId && result.canEdit;
  const allowCreate = allowEdit && showCreateButton && result.canCreate;

  useEffect(() => subscribeToPublishedWorldUpdates(() => {
    setRequestVersion((version) => version + 1);
  }), []);

  useEffect(() => {
    setEditing(null);
    setSavedWorldId(null);
    setCreatedWorldId(null);
  }, [worldId, allowEdit]);

  useEffect(() => { setCreating(null); }, [worldId, allowCreate]);

  useEffect(() => {
    const controller = new AbortController();
    const mutationAtRequest = historyMutationRef.current;
    let ignore = false;
    loadMoreControllerRef.current?.abort();

    void fetchWorldUpdatePage({ worldId, offset: 0, signal: controller.signal })
      .then((page) => {
        if (!ignore && mutationAtRequest === historyMutationRef.current) {
          setResult({
            worldId,
            updates: page.items,
            failed: false,
            hasMore: page.hasMore,
            nextOffset: page.nextOffset,
            loadingMore: false,
            loadMoreFailed: false,
            canEdit: page.canEdit,
            canCreate: page.canCreate,
            canNotify: page.canNotify,
          });
        }
      })
      .catch((error: unknown) => {
        if (ignore || isAbortError(error) || mutationAtRequest !== historyMutationRef.current) return;
        setResult({ ...emptyState(worldId), updates: [], failed: true });
      });

    return () => {
      ignore = true;
      controller.abort();
      loadMoreControllerRef.current?.abort();
    };
  }, [requestVersion, worldId, canEdit]);

  const updates = result.worldId === worldId ? result.updates : null;
  const failed = result.worldId === worldId && result.failed;

  const retry = () => {
    setResult(emptyState(worldId));
    setRequestVersion((version) => version + 1);
  };

  const loadOlder = async () => {
    if (result.worldId !== worldId || result.nextOffset === null || result.loadingMore) return;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    setResult((current) => current.worldId === worldId
      ? { ...current, loadingMore: true, loadMoreFailed: false }
      : current);

    try {
      const page = await fetchWorldUpdatePage({
        worldId,
        offset: result.nextOffset,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setResult((current) => {
        if (current.worldId !== worldId || current.updates === null) return current;
        const knownIds = new Set(current.updates.map((update) => update.id));
        const appended = page.items.filter((update) => !knownIds.has(update.id));
        return {
          ...current,
          updates: [...current.updates, ...appended],
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
          loadingMore: false,
          loadMoreFailed: false,
          canEdit: page.canEdit,
          canCreate: page.canCreate,
          canNotify: page.canNotify,
        };
      });
    } catch (error: unknown) {
      if (isAbortError(error)) return;
      setResult((current) => current.worldId === worldId
        ? { ...current, loadingMore: false, loadMoreFailed: true }
        : current);
    }
  };

  const renderContent = () => {
  if (updates === null) {
    return (
      <div role="status" className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
        {t("detail.updateHistoryLoading")}
      </div>
    );
  }

  if (failed) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-6 text-center text-sm text-muted-foreground">
        <p>{t("detail.updateHistoryLoadError")}</p>
        <button
          type="button"
          onClick={retry}
          className="min-h-11 rounded-xl border border-white/10 bg-white/[0.04] px-4 font-semibold text-foreground transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {t("detail.updateHistoryRetry")}
        </button>
      </div>
    );
  }

  if (updates.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{t("detail.noUpdateHistory")}</p>;
  }

  const locale = i18n.resolvedLanguage || i18n.language || undefined;
  const fallbackAuthor = creatorName?.trim() || t("detail.unknown");

  return (
    <>
    <div
      role="region"
      aria-label={t("detail.updateHistoryListLabel")}
      tabIndex={0}
      className="max-h-80 overflow-y-auto pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 [scrollbar-gutter:stable]"
    >
      <ol className="space-y-0">
        {updates.map((update, index) => {
          const timestamp = new Date(update.createdAt);
          const validTimestamp = !Number.isNaN(timestamp.getTime());
          return (
            <li key={update.id} className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0">
              <div className="relative flex justify-center" aria-hidden="true">
                {index < updates.length - 1 && <span className="absolute bottom-[-0.25rem] top-3 w-px bg-white/10" />}
                <span className={`relative mt-1.5 h-2.5 w-2.5 rounded-full border ${update.isMajor ? "border-primary bg-primary shadow-[0_0_10px_rgba(201,162,94,0.45)]" : "border-white/25 bg-white/10"}`} />
              </div>
              <article className="min-w-0 rounded-xl border border-white/8 bg-white/[0.025] p-3.5">
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                  <h3 className="min-w-0 flex-1 break-words text-sm font-bold leading-5 text-foreground">{update.title}</h3>
                  {update.isMajor && (
                    <span className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-primary">
                      {t("detail.majorUpdate")}
                    </span>
                  )}
                  {allowEdit && update.worldId && (
                    <button
                      type="button"
                      onClick={(event) => {
                        setSavedWorldId(null);
                        setCreatedWorldId(null);
                        setEditing({ worldId, update, trigger: event.currentTarget });
                      }}
                      className="-my-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-1 text-xs font-medium text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      {t("detail.editUpdate")}
                    </button>
                  )}
                </div>
                {update.content && (
                  <p className="mt-2 whitespace-pre-line break-words text-sm leading-5 text-foreground/70">{update.content}</p>
                )}
                <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                  <span>{t("detail.updatedBy", { name: update.creatorName || fallbackAuthor })}</span>
                  {validTimestamp && (
                    <React.Fragment>
                      <span aria-hidden="true">•</span>
                      <time dateTime={timestamp.toISOString()}>
                        {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)}
                      </time>
                    </React.Fragment>
                  )}
                </p>
              </article>
            </li>
          );
        })}
      </ol>

      {(result.hasMore || result.loadingMore || result.loadMoreFailed) && (
        <div className="mt-4 flex flex-col items-center gap-2 border-t border-white/8 pt-4">
          {result.loadMoreFailed && (
            <p className="text-xs text-muted-foreground">{t("detail.updateHistoryLoadMoreError")}</p>
          )}
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={result.loadingMore}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-foreground transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-60"
          >
            {result.loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {result.loadingMore ? t("detail.loadingOlderUpdates") : t("detail.loadOlderUpdates")}
          </button>
        </div>
      )}
    </div>
    {savedWorldId === worldId && (
      <p role="status" className="mt-3 text-center text-sm text-primary">{t("detail.updateSaved")}</p>
    )}
    {allowEdit && editing?.worldId === worldId && (
      <WorldUpdateEditDialog
        key={`${worldId}:${editing.update.id}`}
        update={editing.update}
        trigger={editing.trigger}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          // A refresh started before this write must not replace the saved text.
          historyMutationRef.current += 1;
          setResult((current) => current.worldId === worldId && current.updates !== null
            ? {
                ...current,
                updates: current.updates.map((update) => update.id === saved.id && update.worldId === saved.worldId ? saved : update),
              }
            : current);
          setSavedWorldId(worldId);
          setEditing(null);
        }}
      />
    )}
    </>
  );
  };

  return (
    <>
      {(heading || (showCreateButton && allowEdit)) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {heading}
          {showCreateButton && allowEdit && (
            <button
              type="button"
              disabled={!allowCreate}
              onClick={(event) => {
                setSavedWorldId(null);
                setCreatedWorldId(null);
                setCreating({ worldId, trigger: event.currentTarget });
              }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("detail.addUpdate")}
            </button>
          )}
        </div>
      )}
      {showCreateButton && allowEdit && !result.canCreate && (
        <p className="mb-4 text-sm text-muted-foreground">{t("detail.updateCreateBlocked")}</p>
      )}
      {renderContent()}
      {createdWorldId === worldId && (
        <p role="status" className="mt-3 text-center text-sm text-primary">{t("detail.updateCreated")}</p>
      )}
      {allowCreate && creating?.worldId === worldId && (
        <WorldUpdateCreateDialog
          key={worldId}
          worldId={worldId}
          canNotify={result.canNotify}
          trigger={creating.trigger}
          onClose={() => setCreating(null)}
          onSaved={(created) => {
            historyMutationRef.current += 1;
            setResult((current) => current.worldId === worldId && current.updates !== null
              ? { ...current, updates: [created, ...current.updates.filter((item) => item.id !== created.id)] }
              : current);
            setCreating(null);
            setCreatedWorldId(worldId);
            notifyPublishedWorldUpdate();
          }}
        />
      )}
    </>
  );
}
