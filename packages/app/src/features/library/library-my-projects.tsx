import { useState, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Search,
  Trash2,
  Loader2,
  GitFork,
  FolderOpen,
  Clock,
  ShieldAlert,
  AlertCircle,
  ChevronRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import type { WorldItem } from "@/stores/worlds";
import { useWorldsStore } from "@/stores/worlds";
import { useLibrarySearchStore, type LibraryProjectSort } from "@/stores/library-search";
import { usePlayWithLanguage } from "@/hooks/use-play-with-language";
import { escapeHtml } from "@/lib/markdown";
import { isOwnTranslationSource } from "@/lib/fork-attribution";
import { LibraryGameCard } from "./library-game-card";
import { LibraryTombstoneCard } from "./library-tombstone-card";
import { LibraryEmptyState } from "./library-empty-state";
import { SortDropdown } from "./sort-dropdown";
import { BulkActionsBar } from "./bulk-actions-bar";
import { tallyReviewStates } from "@/lib/review-state";
import { getCreatorHubUrl } from "@/lib/creator-hub-url";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface LibraryMyProjectsProps {
  worlds: WorldItem[];
  userId: string;
  searchQuery: string;
  onSelectItem: (item: WorldItem) => void;
  loading?: boolean;
}

export function LibraryMyProjects({
  worlds,
  userId,
  searchQuery,
  onSelectItem,
  loading: externalLoading,
}: LibraryMyProjectsProps) {
  const { t } = useTranslation("library");
  const sortBy = useLibrarySearchStore((s) => s.projectSort);
  const setSortBy = useLibrarySearchStore((s) => s.setProjectSort);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<WorldItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const deleteWorld = useWorldsStore((s) => s.deleteWorld);
  const navigate = useNavigate();

  const apiBase = import.meta.env.VITE_API_URL || "";

  const { handlePlay: playWithLanguage } = usePlayWithLanguage({
    onNavigate: (sessionId, returnContext) => navigate({
      to: "/app/chat/$sessionId",
      params: { sessionId },
      search: { moderationGroupKey: undefined, ...returnContext },
    }),
    historySource: "library",
    historyInteraction: "play-click",
  });

  const handlePlay = useCallback(async (item: WorldItem) => {
    playWithLanguage(item);
  }, [playWithLanguage]);

  async function handleDelete() {
    if (!confirmDeleteItem) return;
    if (confirmDeleteItem.isPublished && deleteConfirmText !== confirmDeleteItem.name) return;
    setDeleting(true);
    await deleteWorld(confirmDeleteItem.id);
    setDeleting(false);
    setConfirmDeleteItem(null);
    setDeleteConfirmText("");
  }

  function toggleSelect(id: string, next: boolean) {
    setSelectedIds((prev) => {
      const s = new Set(prev);
      if (next) s.add(id);
      else s.delete(id);
      return s;
    });
  }

  function exitBulkMode() {
    setBulkMode(false);
    setSelectedIds(new Set());
  }

  const publishedSelectedCount = Array.from(selectedIds).filter((id) => {
    const w = worlds.find((x) => x.id === id);
    return !!w?.isPublished;
  }).length;

  async function handleBulkDelete() {
    if (selectedIds.size === 0 || publishedSelectedCount > 0) return;
    setBulkDeleting(true);
    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(ids.map((id) => deleteWorld(id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    const success = ids.length - failed;
    // T0 on a clean sweep — the cards are gone. Speak only when some survived.
    if (failed > 0) {
      feedback.error(
        success === 0
          ? t("bulk.deletedFailed")
          : t("bulk.deletedPartial", { success, total: ids.length, failed }),
      );
    }
    setBulkDeleting(false);
    setConfirmBulkDelete(false);
    exitBulkMode();
  }

  async function handleExportProject(item: WorldItem) {
    try {
      const res = await fetch(`${apiBase}/api/worlds/${item.id}`, { credentials: "include" });
      // R6/T0: the browser's own download shelf confirms the good case.
      if (!res.ok) { feedback.error(t("toast.failedToExport")); return; }
      const { data } = await res.json();
      const blob = new Blob([JSON.stringify(data.schema ?? {}, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(item.name || "world").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      feedback.error(t("toast.failedToExport"));
    }
  }

  // All user-created worlds (originals + forks)
  const myProjects = worlds.filter(
    (w) => w.creatorId === userId
  );

  // In-flight review tally across my cards — drives the top banner that links to
  // the creator dashboard's 审核进度 section. A published card's held-edit state
  // lives in `pendingEdit` (its `status` stays "published"), so this is the only
  // place "我的作品" can surface "your update is in review / awaiting submit".
  const reviewTally = tallyReviewStates(myProjects);
  const reviewHubUrl = `${getCreatorHubUrl()}#review-progress`;

  // Build a map of fork world ID -> source world name for attribution.
  // Skips the author's own translations: a language variant points at its own
  // sibling, so attributing it would label the English card "Based on <its own
  // Chinese title>".
  const sourceWorldNames = new Map<string, string>();
  for (const w of myProjects) {
    if (!w.sourceWorldId) continue;
    const source = worlds.find((sw) => sw.id === w.sourceWorldId);
    if (source && !isOwnTranslationSource(w, source)) {
      sourceWorldNames.set(w.id, source.name);
    }
  }

  const filtered = myProjects.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "title":
        return a.name.localeCompare(b.name);
      case "recent":
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      case "releaseDate":
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      default:
        return 0;
    }
  });

  const drafts = sorted.filter((w) => w.status !== "pending_review" && w.status !== "rejected" && !w.isPublished);
  const inReview = sorted.filter((w) => w.status === "pending_review");
  const rejected = sorted.filter((w) => w.status === "rejected");
  const published = sorted.filter((w) => w.isPublished);

  return (
    <>
    <div className="library-section-stack mb-10">
      {reviewTally.total > 0 && (
        <a
          href={reviewHubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group mx-2 flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/[0.06] px-4 py-3 transition-colors hover:border-primary/40 hover:bg-primary/[0.1]"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="text-sm font-semibold text-foreground">{t("reviewBanner.title")}</span>
            {reviewTally.in_review > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-blue-400">
                <Clock size={13} />
                {t("reviewBanner.inReview", { count: reviewTally.in_review })}
              </span>
            )}
            {reviewTally.pending_submit > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-amber-400">
                <ShieldAlert size={13} />
                {t("reviewBanner.pendingSubmit", { count: reviewTally.pending_submit })}
              </span>
            )}
            {reviewTally.rejected > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle size={13} />
                {t("reviewBanner.rejected", { count: reviewTally.rejected })}
              </span>
            )}
          </div>
          <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
            {t("reviewBanner.cta")}
            <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </a>
      )}

      <div className="library-section-header library-list-header flex flex-wrap items-center justify-between gap-3 px-2">
        <div className="flex items-center gap-3">
          <div className="h-6 w-1.5 rounded-full bg-primary" />
          <h2 className="library-list-title text-2xl font-black tracking-tight text-foreground">
            {t("projects.title")} <span className="text-muted-foreground text-lg font-bold ml-1">{t("projects.count", { count: myProjects.length })}</span>
          </h2>
        </div>

        <div className="flex items-center gap-2">
          <BulkActionsBar
            active={bulkMode}
            selectedCount={selectedIds.size}
            totalCount={sorted.length}
            onToggle={() => (bulkMode ? exitBulkMode() : setBulkMode(true))}
            onSelectAll={() => setSelectedIds(new Set(sorted.map((w) => w.id)))}
            onClear={() => setSelectedIds(new Set())}
            onDelete={() => setConfirmBulkDelete(true)}
          />
          {!bulkMode && (
            <SortDropdown
              value={sortBy}
              onChange={(v) => setSortBy(v as LibraryProjectSort)}
              options={[
                { value: "title", label: t("sort.alphabetical") },
                { value: "recent", label: t("sort.recent") },
                { value: "releaseDate", label: t("sort.releaseDate") },
              ]}
            />
          )}
        </div>
      </div>

      {externalLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
        </div>
      ) : <>
      {/* In Development */}
      {drafts.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-primary mb-4 uppercase tracking-wider flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary" />
            {t("projects.inDevelopment")}{" "}
            <span className="text-muted-foreground font-normal">({drafts.length})</span>
          </h3>
          <div className="library-card-grid">
            {drafts.map((item) => {
              const sourceName = sourceWorldNames.get(item.id);
              const isOrphaned = !!item.sourceWorldId && item.sourceWorldTakenDown === true;

              if (isOrphaned) {
                return (
                  <LibraryTombstoneCard
                    key={item.id}
                    worldName={item.name}
                    thumbnailUrl={item.thumbnailUrl}
                    onExport={() => handleExportProject(item)}
                    onRemove={() => setConfirmDeleteItem(item)}
                    selectable={bulkMode}
                    selected={selectedIds.has(item.id)}
                    onSelectChange={(s) => toggleSelect(item.id, s)}
                  />
                );
              }

              return (
                <div key={item.id} className="flex flex-col">
                  <LibraryGameCard
                    item={item}
                    onClick={() => onSelectItem(item)}
                    status="draft"
                    onEdit={() => navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: item.id } })}
                    onPlay={() => handlePlay(item)}
                    onDelete={() => setConfirmDeleteItem(item)}
                    selectable={bulkMode}
                    selected={selectedIds.has(item.id)}
                    onSelectChange={(s) => toggleSelect(item.id, s)}
                  />
                  {sourceName && (
                    <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5 flex items-center gap-1">
                      <GitFork size={10} className="shrink-0" />
                      {t("projects.basedOn", { name: sourceName })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* In Review */}
      {inReview.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-blue-400 mb-4 uppercase tracking-wider flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            {t("projects.inReview")}{" "}
            <span className="text-muted-foreground font-normal">({inReview.length})</span>
          </h3>
          <div className="library-card-grid">
            {inReview.map((item) => (
              <div key={item.id} className="flex flex-col">
                <LibraryGameCard
                  item={item}
                  onClick={() => onSelectItem(item)}
                  status="pending_review"
                  onEdit={() => navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: item.id } })}
                  onPlay={() => handlePlay(item)}
                  onDelete={() => setConfirmDeleteItem(item)}
                  selectable={bulkMode}
                  selected={selectedIds.has(item.id)}
                  onSelectChange={(s) => toggleSelect(item.id, s)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rejected */}
      {rejected.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-red-400 mb-4 uppercase tracking-wider flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-400" />
            {t("projects.rejected")}{" "}
            <span className="text-muted-foreground font-normal">({rejected.length})</span>
          </h3>
          <div className="library-card-grid">
            {rejected.map((item) => (
              <div key={item.id} className="flex flex-col">
                <LibraryGameCard
                  item={item}
                  onClick={() => onSelectItem(item)}
                  status="rejected"
                  onEdit={() => navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: item.id } })}
                  onPlay={() => handlePlay(item)}
                  onDelete={() => setConfirmDeleteItem(item)}
                  selectable={bulkMode}
                  selected={selectedIds.has(item.id)}
                  onSelectChange={(s) => toggleSelect(item.id, s)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Published */}
      {published.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-green-400 mb-4 uppercase tracking-wider flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400" />
            {t("projects.published")}{" "}
            <span className="text-muted-foreground font-normal">
              ({published.length})
            </span>
          </h3>
          <div className="library-card-grid">
            {published.map((item) => {
              const sourceName = sourceWorldNames.get(item.id);
              const isOrphaned = !!item.sourceWorldId && item.sourceWorldTakenDown === true;

              if (isOrphaned) {
                return (
                  <LibraryTombstoneCard
                    key={item.id}
                    worldName={item.name}
                    thumbnailUrl={item.thumbnailUrl}
                    onExport={() => handleExportProject(item)}
                    onRemove={() => setConfirmDeleteItem(item)}
                    selectable={bulkMode}
                    selected={selectedIds.has(item.id)}
                    onSelectChange={(s) => toggleSelect(item.id, s)}
                  />
                );
              }

              return (
                <div key={item.id} className="flex flex-col">
                  <LibraryGameCard
                    item={item}
                    onClick={() => onSelectItem(item)}
                    status="published"
                    onEdit={() => navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: item.id } })}
                    onPlay={() => handlePlay(item)}
                    onDelete={() => setConfirmDeleteItem(item)}
                    selectable={bulkMode}
                    selected={selectedIds.has(item.id)}
                    onSelectChange={(s) => toggleSelect(item.id, s)}
                  />
                  {sourceName && (
                    <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5 flex items-center gap-1">
                      <GitFork size={10} className="shrink-0" />
                      {t("projects.basedOn", { name: sourceName })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sorted.length === 0 && (
        searchQuery ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Search size={48} className="mb-4 opacity-20" />
            <p className="text-sm">
              No results for &ldquo;{searchQuery}&rdquo; - try clearing your search.
            </p>
          </div>
        ) : (
          <LibraryEmptyState
            icon={<FolderOpen size={36} />}
            headline={t("projects.emptyHeadline")}
            subtitle={t("projects.emptySubtitle")}
            ctaLabel={t("projects.emptyCta")}
            onCta={() => navigate({ to: "/app/worlds/create" })}
          />
        )
      )}
      </>}
    </div>

    <ConfirmDialog
      open={!!confirmDeleteItem}
      onOpenChange={(open) => {
        if (!open && !deleting) {
          setConfirmDeleteItem(null);
          setDeleteConfirmText("");
        }
      }}
      title={t("dialog.deleteProject")}
      description={confirmDeleteItem?.isPublished ? undefined : t("dialog.deleteIrreversible")}
      descriptionHtml={confirmDeleteItem?.isPublished
        ? t("dialog.deletePublishedWarning", { name: escapeHtml(confirmDeleteItem.name) })
        : undefined}
      confirmLabel={t("dialog.deletePermanently")}
      cancelLabel={t("dialog.cancel")}
      onConfirm={handleDelete}
      busy={deleting}
      item={confirmDeleteItem ? {
        name: confirmDeleteItem.name,
        detail: t("tabs.myProjects"),
        imageUrl: confirmDeleteItem.thumbnailUrl,
      } : undefined}
      requireText={confirmDeleteItem?.isPublished ? confirmDeleteItem.name : undefined}
      requireTextLabel={confirmDeleteItem?.isPublished ? (
        <span dangerouslySetInnerHTML={{
          __html: t("dialog.deleteTypeConfirm", { name: escapeHtml(confirmDeleteItem.name) }),
        }} />
      ) : undefined}
      typedValue={deleteConfirmText}
      onTypedValueChange={setDeleteConfirmText}
    />

    {/* Bulk delete confirmation */}
    <Dialog
      open={confirmBulkDelete}
      onOpenChange={(open) => { if (!open && !bulkDeleting) setConfirmBulkDelete(false); }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 size={18} className="text-red-400" />
            {t("bulk.deleteTitle", { count: selectedIds.size })}
          </DialogTitle>
          {publishedSelectedCount > 0 ? (
            <DialogDescription>
              {t("bulk.deleteConfirmProjectsPublishedBlocked", { count: publishedSelectedCount })}
            </DialogDescription>
          ) : (
            <DialogDescription dangerouslySetInnerHTML={{ __html: t("bulk.deleteConfirmProjects", { count: selectedIds.size }) }} />
          )}
        </DialogHeader>
        <DialogFooter>
          <button
            onClick={() => setConfirmBulkDelete(false)}
            disabled={bulkDeleting}
            className="px-4 py-2 text-sm text-muted-foreground hover:bg-muted rounded transition-colors"
          >
            {t("dialog.cancel")}
          </button>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting || publishedSelectedCount > 0 || selectedIds.size === 0}
            className="px-4 py-2 text-sm bg-red-600 text-white font-medium rounded hover:bg-red-700 transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {bulkDeleting && <Loader2 size={14} className="animate-spin" />}
            {bulkDeleting ? t("bulk.deleting") : t("bulk.delete")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    </>
  );
}
