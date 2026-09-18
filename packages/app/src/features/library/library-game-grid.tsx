import { useState, useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Search,
  Loader2,
  Library,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import type { WorldItem } from "@/stores/worlds";
import { useWorldsStore } from "@/stores/worlds";
import { useLibraryStore, type LibraryItem } from "@/stores/library";
import { useLibrarySearchStore } from "@/stores/library-search";
import { useFavoritesStore } from "@/edition/slots.state";
import { useEdition } from "@/edition/edition";
import { getLandingRoute } from "@/edition/routes";
import { usePlayWithLanguage } from "@/hooks/use-play-with-language";
import { escapeHtml } from "@/lib/markdown";
import { VariantDownloadPicker } from "@/components/variant-download-picker";
import { VariantForkPicker } from "@/components/variant-fork-picker";
import { fetchVariantsForDownload } from "@/lib/download-world";
import type { LanguageVariant } from "@/lib/languages";
import { LibraryGameCard } from "./library-game-card";
import { sortLibraryGameItems, type LibraryGameSort } from "./library-game-sort";
import { LibraryEmptyState } from "./library-empty-state";
import { LibraryTombstoneCard } from "./library-tombstone-card";
import { SortDropdown } from "./sort-dropdown";
import { BulkActionsBar } from "./bulk-actions-bar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const apiBase = import.meta.env.VITE_API_URL || "";

interface LibraryGameGridProps {
  searchQuery: string;
  onSelectItem: (item: WorldItem) => void;
  onRemixComplete?: (newWorld: WorldItem) => void;
  showNsfw?: boolean;
  userId?: string;
  loading?: boolean;
}

export function LibraryGameGrid({
  searchQuery,
  onSelectItem,
  onRemixComplete,
  showNsfw,
  userId,
  loading: externalLoading,
}: LibraryGameGridProps) {
  const { t } = useTranslation("library");
  const sortBy = useLibrarySearchStore((s) => s.gameSort);
  const setSortBy = useLibrarySearchStore((s) => s.setGameSort);
  const [confirmCopyItem, setConfirmCopyItem] = useState<WorldItem | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<{
    worldId: string;
    worldName: string;
    thumbnailUrl?: string | null;
  } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const copyingRef = useRef(false);
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);
  const favorites = useFavoritesStore((s) => s.favorites);
  const sortFavoriteIdsRef = useRef<ReadonlySet<string> | null>(null);
  if (sortFavoriteIdsRef.current === null) {
    sortFavoriteIdsRef.current = new Set(favorites.map((favorite) => favorite.worldId));
  }
  const isFavorited = useFavoritesStore((s) => s.isFavorited);
  const { features } = useEdition();
  const worlds = useWorldsStore((s) => s.worlds);
  const libraryItems = useLibraryStore((s) => s.items);
  const hasMore = useLibraryStore((s) => s.hasMore);
  const fetchMore = useLibraryStore((s) => s.fetchMore);
  const removeFromLibrary = useLibraryStore((s) => s.removeFromLibrary);
  const navigate = useNavigate();

  const { handlePlay } = usePlayWithLanguage({
    onNavigate: (sessionId, returnContext) => navigate({
      to: "/app/chat/$sessionId",
      params: { sessionId },
      search: { moderationGroupKey: undefined, ...returnContext },
    }),
    historySource: "library",
    historyInteraction: "play-click",
  });

  // The card whose session is being created shows a spinner on its Play button
  // and ignores further taps. The old silent 1–2s gap between tap and navigation
  // is where the library's rage clicks came from ("PLAY" was its top target).
  const [playPendingId, setPlayPendingId] = useState<string | null>(null);
  const startPlay = useCallback(
    async (world: Parameters<typeof handlePlay>[0]) => {
      if (playPendingId) return;
      setPlayPendingId(world.id);
      try {
        await handlePlay(world);
      } finally {
        setPlayPendingId(null);
      }
    },
    [handlePlay, playPendingId],
  );

  const [downloadPickerOpen, setDownloadPickerOpen] = useState(false);
  const [downloadVariants, setDownloadVariants] = useState<LanguageVariant[]>([]);
  const [downloadWorldId, setDownloadWorldId] = useState("");
  const [downloadWorldName, setDownloadWorldName] = useState("");

  const [forkPickerOpen, setForkPickerOpen] = useState(false);
  const [forkVariants, setForkVariants] = useState<LanguageVariant[]>([]);
  const [forkPickerWorldName, setForkPickerWorldName] = useState("");

  const handleDownload = useCallback(async (worldId: string, worldName: string, languageGroupId?: string | null) => {
    const variants = languageGroupId ? await fetchVariantsForDownload(worldId) : [];
    setDownloadWorldId(worldId);
    setDownloadVariants(variants);
    // eslint-disable-next-line no-control-regex -- filesystem control characters are invalid in download names
    setDownloadWorldName(worldName?.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") ?? "");
    setDownloadPickerOpen(true);
  }, []);

  // Build a lookup from worldId to the full WorldItem (for published library items)
  const worldsById = new Map(worlds.map((w) => [w.id, w]));

  // Filter library items
  const filteredLibrary = libraryItems.filter((li) => {
    if (li.worldIsNsfw && !showNsfw) return false;
    if (searchQuery && !li.worldName.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  // Favorites still lead the list, but the membership used for sorting is
  // frozen for this mount. Tapping a heart updates its visual state in place;
  // the new favorite order takes effect after the next page entry/refresh.
  const sorted = sortLibraryGameItems(filteredLibrary, sortBy, sortFavoriteIdsRef.current);

  // Inner duplicate request used by both the single-variant flow and the
  // VariantForkPicker. Surfaces the server's `error` field on non-OK so a
  // 403 ("This world does not allow forking") reaches the user as a
  // specific message instead of the generic "复制游戏到项目失败" toast.
  async function performCopy(worldId: string) {
    if (copyingRef.current) return;
    copyingRef.current = true;
    setCopying(true);
    try {
      const res = await fetch(
        `${apiBase}/api/worlds/${worldId}/duplicate`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) {
        // R7: the confirm dialog closes on the way out, so the failure has no
        // control left to sit beside.
        feedback.error(t("toast.failedToCopy"));
        return;
      }
      const { data: newWorld } = await res.json();
      // T0: the copy lands in My Projects (or the remix flow navigates
      // straight into it) — the new card is the confirmation.
      if (onRemixComplete) {
        onRemixComplete(newWorld);
      } else {
        useWorldsStore.getState().invalidate();
      }
    } catch {
      feedback.error(t("toast.failedToCopy"));
    } finally {
      copyingRef.current = false;
      setCopying(false);
      setConfirmCopyItem(null);
      setForkPickerOpen(false);
    }
  }

  async function handleCopyToProject() {
    if (!confirmCopyItem) return;
    await performCopy(confirmCopyItem.id);
  }

  async function handleEditClick(item: WorldItem) {
    const isOwner = !!userId && item.creatorId === userId && !item.sourceWorldId;
    if (isOwner) {
      navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: item.id } });
      return;
    }
    // Rule: guidance about a blocked action lives on the control, not in a
    // pill. The Edit button is simply not offered when the author locked the
    // card (see `canFork` at the call sites), so this is only a guard.
    if (item.allowEdit === false) return;
    // No language group → simple confirm dialog (preserves existing UX).
    if (!item.languageGroupId) {
      setConfirmCopyItem(item);
      return;
    }
    // Has a language group → fetch the variants and open the picker so the
    // user can pick which version to fork (and see which are locked).
    try {
      const res = await fetch(
        `${apiBase}/api/worlds/${item.id}/language-variants`,
        { credentials: "include" },
      );
      if (!res.ok) {
        setConfirmCopyItem(item);
        return;
      }
      const { data } = (await res.json()) as { data: LanguageVariant[] };
      if (!Array.isArray(data) || data.length <= 1) {
        setConfirmCopyItem(item);
        return;
      }
      const forkables = data.filter((v) => v.allowEdit !== false);
      const owned = userId ? data.filter((v) => v.creatorId === userId) : [];
      // Single-forkable shortcut: if the user doesn't own any sibling and
      // exactly one variant is forkable, just fork that one — saves a click
      // for the common "main version + locked调参版" pattern.
      if (owned.length === 0 && forkables.length === 1) {
        await performCopy(forkables[0]!.id);
        return;
      }
      setForkVariants(data);
      setForkPickerWorldName(item.name);
      setForkPickerOpen(true);
    } catch {
      // Network error — fall back to the simple confirm flow.
      setConfirmCopyItem(item);
    }
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

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(ids.map((id) => removeFromLibrary(id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    const success = ids.length - failed;
    // T0 when it all worked — the selected cards are gone from the grid. Only a
    // failure (total or partial) needs saying, because some cards came back.
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

  // Helper: render a library item either as a normal card or tombstone
  function renderLibraryItem(li: LibraryItem) {
    const isUnpublished = li.worldStatus === "unpublished";
    const isSelected = selectedIds.has(li.worldId);

    if (isUnpublished) {
      return (
        <LibraryTombstoneCard
          key={li.libraryId}
          worldName={li.worldName}
          thumbnailUrl={li.worldThumbnailUrl}
          onExport={() => handleDownload(li.worldId, li.worldName, li.worldLanguageGroupId)}
          onRemove={() => setConfirmRemoveId({ worldId: li.worldId, worldName: li.worldName, thumbnailUrl: li.worldThumbnailUrl })}
          selectable={bulkMode}
          selected={isSelected}
          onSelectChange={(s) => toggleSelect(li.worldId, s)}
        />
      );
    }

    // Published, find the corresponding WorldItem for the card
    const worldItem = worldsById.get(li.worldId);
    if (!worldItem) {
      // We have a library reference but no local world record, render a minimal card
      // Construct a synthetic WorldItem from library data
      const syntheticItem: WorldItem = {
        id: li.worldId,
        creatorId: li.creatorId,
        name: li.worldName,
        description: li.worldDescription,
        schema: {},
        thumbnailUrl: li.worldThumbnailUrl,
        coverCrop: li.worldCoverCrop ?? null,
        galleryCoverCrop: li.worldGalleryCoverCrop ?? null,
        isPublished: true,
        isNsfw: li.worldIsNsfw,
        // Pass through the variant's actual allow_edit so disabled-fork
        // variants render the correct UI affordances. Hard-coded `null`
        // previously caused the Library "Edit" button to appear even on
        // variants the author had locked, leading to a server 403 →
        // generic "复制游戏到项目失败" toast (the kljws bug).
        allowEdit: li.worldAllowEdit ?? null,
        allowReviews: li.worldAllowReviews ?? null,
        downloadCount: li.worldDownloadCount ?? 0,
        messageCount: li.worldMessageCount ?? 0,
        tags: li.worldTags,
        announcement: null,
        totalTokens: null,
        approxTime: null,
        galleryImages: null,
        sourceWorldId: null,
        sourceWorldTakenDown: null,
        moderationNote: null,
        moderationAction: null,
        creatorName: li.creatorName,
        language: li.worldLanguage ?? null,
        languageGroupId: li.worldLanguageGroupId ?? null,
        createdAt: li.addedAt,
        updatedAt: li.lastPlayedAt ?? li.addedAt,
      };

      const ownsSynthetic = !!userId && li.creatorId === userId;
      const canDownload = li.worldAllowEdit !== false || ownsSynthetic;
      const canFork = li.worldAllowEdit !== false || ownsSynthetic;
      return (
        <LibraryGameCard
          key={li.libraryId}
          item={syntheticItem}
          onClick={() => onSelectItem(syntheticItem)}
          status="installed"
          hasUpdate={li.hasUpdate}
          onPlay={() => void startPlay({ id: li.worldId, name: li.worldName, thumbnailUrl: li.worldThumbnailUrl, language: li.worldLanguage, languageGroupId: li.worldLanguageGroupId ?? null })}
          playPending={playPendingId === li.worldId}
          onEdit={canFork ? () => handleEditClick(syntheticItem) : undefined}
          onDelete={() => setConfirmRemoveId({ worldId: li.worldId, worldName: li.worldName, thumbnailUrl: li.worldThumbnailUrl })}
          deleteTitle={t("games.removeFromLibrary")}
          onDownload={canDownload ? () => handleDownload(li.worldId, li.worldName) : undefined}
          onToggleFavorite={features.hub ? () => void toggleFavorite(li.worldId, { worldName: li.worldName, worldThumbnailUrl: li.worldThumbnailUrl }) : undefined}
          isFavorited={isFavorited(li.worldId)}
          selectable={bulkMode}
          selected={isSelected}
          onSelectChange={(s) => toggleSelect(li.worldId, s)}
        />
      );
    }

    const isOwner = !!userId && worldItem.creatorId === userId;
    const canDownloadWorld = worldItem.allowEdit !== false || isOwner;
    const canForkWorld = worldItem.allowEdit !== false || isOwner;
    return (
      <LibraryGameCard
        key={li.libraryId}
        item={worldItem}
        onClick={() => onSelectItem(worldItem)}
        status="installed"
        hasUpdate={li.hasUpdate}
        onEdit={canForkWorld ? () => handleEditClick(worldItem) : undefined}
        onDelete={() => setConfirmRemoveId({ worldId: li.worldId, worldName: worldItem.name, thumbnailUrl: worldItem.thumbnailUrl })}
        deleteTitle={t("games.removeFromLibrary")}
        onPlay={() => void startPlay({ id: worldItem.id, name: worldItem.name, thumbnailUrl: worldItem.thumbnailUrl, language: worldItem.language, languageGroupId: li.worldLanguageGroupId ?? null })}
        playPending={playPendingId === li.worldId}
        onDownload={canDownloadWorld ? () => handleDownload(worldItem.id, worldItem.name) : undefined}
        onToggleFavorite={features.hub ? () => void toggleFavorite(li.worldId, { worldName: worldItem.name, worldThumbnailUrl: worldItem.thumbnailUrl }) : undefined}
        isFavorited={isFavorited(li.worldId)}
        selectable={bulkMode}
        selected={isSelected}
        onSelectChange={(s) => toggleSelect(li.worldId, s)}
      />
    );
  }

  return (
    <>
      <div className="library-section-stack mb-10">
        <div className="library-section-header library-list-header flex flex-wrap items-center justify-between gap-3 px-2">
          <div className="flex items-center gap-3">
            <div className="h-6 w-1.5 rounded-full bg-primary" />
            <h2 className="library-list-title text-2xl font-black tracking-tight text-foreground">
              {t("games.title")} <span className="text-muted-foreground text-lg font-bold ml-1">{t("games.count", { count: sorted.length })}</span>
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <BulkActionsBar
              active={bulkMode}
              selectedCount={selectedIds.size}
              totalCount={sorted.length}
              onToggle={() => (bulkMode ? exitBulkMode() : setBulkMode(true))}
              onSelectAll={() => setSelectedIds(new Set(sorted.map((li) => li.worldId)))}
              onClear={() => setSelectedIds(new Set())}
              onDelete={() => setConfirmBulkDelete(true)}
            />
            {!bulkMode && (
              <SortDropdown
                value={sortBy}
                onChange={(v) => setSortBy(v as LibraryGameSort)}
                options={[
                  { value: "title", label: t("sort.alphabetical") },
                  { value: "recent", label: t("sort.recent") },
                  { value: "added", label: t("sort.added") },
                ]}
              />
            )}
          </div>
        </div>

        {externalLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
          </div>
        ) : sorted.length > 0 ? (
          <>
            <div className="library-card-grid">
              {sorted.map((li) => renderLibraryItem(li))}
            </div>
            {hasMore && (
              <div className="flex justify-center pt-4">
                <button
                  onClick={() => fetchMore()}
                  disabled={externalLoading}
                  className="px-6 py-2 text-sm font-medium text-muted-foreground border border-white/10 rounded-lg hover:bg-white/5 hover:text-foreground transition-colors disabled:opacity-40"
                >
                  {externalLoading ? <Loader2 size={16} className="animate-spin" /> : t("games.loadMore")}
                </button>
              </div>
            )}
          </>
        ) : (
          searchQuery ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <Search size={48} className="mb-4 opacity-20" />
              <p className="text-sm">
                No results for &ldquo;{searchQuery}&rdquo; - try clearing your search.
              </p>
            </div>
          ) : (
            <LibraryEmptyState
              icon={<Library size={36} />}
              headline={t("games.emptyHeadline")}
              subtitle={t("games.emptySubtitle")}
              ctaLabel={features.hub ? t("games.emptyCta") : undefined}
              onCta={features.hub ? () => navigate({ to: getLandingRoute() }) : undefined}
            />
          )
        )}
      </div>

      <ConfirmDialog
        open={!!confirmRemoveId}
        onOpenChange={(open) => { if (!open && !removing) setConfirmRemoveId(null); }}
        title={t("games.removeFromLibrary")}
        descriptionHtml={t("games.removeConfirm", { name: escapeHtml(confirmRemoveId?.worldName ?? "") })}
        confirmLabel={t("games.removeAction")}
        cancelLabel={t("dialog.cancel")}
        busy={removing}
        item={confirmRemoveId ? {
          name: confirmRemoveId.worldName,
          detail: t("tabs.games"),
          imageUrl: confirmRemoveId.thumbnailUrl,
        } : undefined}
        onConfirm={async () => {
          if (!confirmRemoveId || removing) return;
          setRemoving(true);
          await removeFromLibrary(confirmRemoveId.worldId);
          setRemoving(false);
          setConfirmRemoveId(null);
        }}
      />

      {/* Edit as My Project confirmation dialog */}
      <Dialog
        open={!!confirmCopyItem}
        onOpenChange={(open) => { if (!open) setConfirmCopyItem(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dialog.editAsMyProject")}</DialogTitle>
            <DialogDescription dangerouslySetInnerHTML={{ __html: t("dialog.editAsMyProjectDesc", { creator: escapeHtml(confirmCopyItem?.creatorName || "another creator"), name: escapeHtml(confirmCopyItem?.name ?? "") }) }} />
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setConfirmCopyItem(null)}
              disabled={copying}
              className="px-4 py-2 text-sm text-muted-foreground hover:bg-muted rounded transition-colors"
            >
              {t("dialog.cancel")}
            </button>
            <button
              onClick={handleCopyToProject}
              disabled={copying}
              className="px-4 py-2 text-sm bg-[#3B82F6] text-white font-medium rounded hover:bg-[#3B82F6]/85 transition-colors flex items-center gap-2"
            >
              {copying && <Loader2 size={14} className="animate-spin" />}
              {t("dialog.createCopy")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VariantDownloadPicker
        open={downloadPickerOpen}
        onClose={() => setDownloadPickerOpen(false)}
        worldId={downloadWorldId}
        variants={downloadVariants}
        worldName={downloadWorldName}
      />

      <VariantForkPicker
        open={forkPickerOpen}
        onClose={() => setForkPickerOpen(false)}
        variants={forkVariants}
        currentUserId={userId}
        worldName={forkPickerWorldName}
        onFork={performCopy}
        onEditOwn={(variantId) => {
          setForkPickerOpen(false);
          navigate({
            to: "/app/worlds/$worldId/edit",
            params: { worldId: variantId },
          });
        }}
        loading={copying}
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
            <DialogDescription dangerouslySetInnerHTML={{ __html: t("bulk.deleteConfirmGames", { count: selectedIds.size }) }} />
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
              disabled={bulkDeleting}
              className="px-4 py-2 text-sm bg-red-600 text-white font-medium rounded hover:bg-red-700 transition-colors flex items-center gap-2"
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
