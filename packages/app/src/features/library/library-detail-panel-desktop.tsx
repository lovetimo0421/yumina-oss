import { useOpenWorldPreview } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { getUserProfileHref } from "@/edition/routes";
import { getWorldShareUrl } from "@/edition/slots.state";
import { useStoryNavigation } from "@/hooks/use-story-navigation";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Play,
  Pencil,
  Heart,
  Share2,
  Download,
  FileText,
  Clapperboard,
  MessagesSquare,
  Loader2,
  Flag,
  Trash2,
  GitFork,
  Lock,
  Check,
} from "lucide-react";
import { feedback } from "@/lib/feedback";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import type { WorldItem } from "@/stores/worlds";
import { useWorldsStore } from "@/stores/worlds";
import { useFavoritesStore } from "@/edition/slots.state";
import { useLibraryStore } from "@/stores/library";
import { resolveTagLabel } from "@/edition/slots";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ReportDialog } from "@/components/report-dialog";
import { usePlayWithLanguage } from "@/hooks/use-play-with-language";
import { escapeHtml } from "@/lib/markdown";
import { WorldDescription } from "@/components/world-description";
import { isOwnTranslationSource } from "@/lib/fork-attribution";
import { VariantDownloadPicker } from "@/components/variant-download-picker";
import { VariantForkPicker } from "@/components/variant-fork-picker";
import { fetchVariantsForDownload } from "@/lib/download-world";
import type { LanguageVariant } from "@/lib/languages";
import { CroppedImage } from "@/lib/cover-crop";
import { normalizeWorldCoverCrop } from "@/lib/world-cover-crop";
import { useActivityStats } from "@/lib/library-detail-stats";
import { SessionExportModal } from "./session-export-modal";
import { SharePlaythroughModal } from "@/features/chat/share-playthrough-modal";
import { SharePlaythroughPicker } from "./share-playthrough-picker";
import { SupportBadge } from "@/edition/slots";
import { WorldReviewsSection } from "@/edition/slots";
import { LibraryDetailActivityCard } from "./library-detail-activity-card";

const apiBase = import.meta.env.VITE_API_URL || "";


export interface LibraryDetailPanelProps {
  selectedItem: WorldItem;
  allItems: WorldItem[];
  onSelectItem: (item: WorldItem) => void;
  onBack: () => void;
  isProject?: boolean;
  onRemixComplete?: (newWorld: WorldItem) => void;
  userId?: string;
}

export function LibraryDetailPanelDesktop({
  selectedItem,
  onBack,
  isProject,
  onRemixComplete,
  userId,
}: LibraryDetailPanelProps) {
  const { t } = useTranslation("library");
  const { copied: shareCopied, copy: copyShareLink } = useCopyFeedback();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyingRef = useRef(false);
  const [showReport, setShowReport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [downloadPickerOpen, setDownloadPickerOpen] = useState(false);
  const [downloadVariants, setDownloadVariants] = useState<LanguageVariant[]>([]);
  const [forkPickerOpen, setForkPickerOpen] = useState(false);
  const [forkVariants, setForkVariants] = useState<LanguageVariant[]>([]);
  const [sessionExportOpen, setSessionExportOpen] = useState(false);
  const [sharePickerOpen, setSharePickerOpen] = useState(false);
  const [shareSession, setShareSession] = useState<{ id: string; title: string; worldId: string } | null>(null);
  const navigateToStory = useStoryNavigation();
  const { openWorldPreview } = useOpenWorldPreview();
  const { features } = useEdition();
  const goToUser = (userId: string) => {
    const href = getUserProfileHref(userId);
    if (href) void navigate({ to: href });
  };
  const { handlePlay: playWithLanguage } = usePlayWithLanguage({
    onNavigate: navigateToStory,
    historySource: "library",
    historyInteraction: "play-click",
  });
  const deleteWorld = useWorldsStore((s) => s.deleteWorld);
  const isFavorited = useFavoritesStore(s => s.isFavorited);
  const toggleFavorite = useFavoritesStore(s => s.toggleFavorite);
  // Subscribe to the `favorites` array (not just the `isFavorited` function
  // ref, which is stable across renders) so the heart icon flips visually
  // when the user toggles. Without this the click handler runs and the
  // store updates correctly, but the panel doesn't re-render.
  useFavoritesStore((s) => s.favorites);
  const libraryLastPlayedAt = useLibraryStore((s) =>
    s.items.find((item) => item.worldId === selectedItem.id)?.lastPlayedAt ?? null
  );
  const favorited = isFavorited(selectedItem.sourceWorldId ?? selectedItem.id);

  const isOriginalAuthor = !!userId && selectedItem.creatorId === userId && !selectedItem.sourceWorldId;
  const isOrphanedFork = !!selectedItem.sourceWorldId && selectedItem.sourceWorldTakenDown === true;
  const canEditDirectly = !isOrphanedFork && (isProject || isOriginalAuthor);
  const canDelete = !!userId && selectedItem.creatorId === userId;
  const canViewCreatorAnalytics = true;

  // Resolve "Based on X by Y" attribution. Prefer the server-attached
  // fields (work for forks of *anyone's* world, including ones not in
  // this user's local store), then fall back to the worlds store lookup
  // so older cached API responses — and the brief window during a
  // server deploy where the new fields aren't shipping yet — still
  // render correctly. /api/worlds returns all published worlds the user
  // can see, so the original is typically in `allWorlds`.
  const allWorlds = useWorldsStore((s) => s.worlds);
  const sourceWorldEntry = selectedItem.sourceWorldId
    ? allWorlds.find((w) => w.id === selectedItem.sourceWorldId) ?? null
    : null;
  // A translated variant points at its own sibling — lineage, not credit. Both
  // the server field and the store fallback have to honor that, or the English
  // card reads "Based on <its own Chinese title>".
  const sourceIsOwnTranslation = isOwnTranslationSource(selectedItem, sourceWorldEntry);
  const sourceWorldName = selectedItem.sourceWorldId && !sourceIsOwnTranslation
    ? selectedItem.sourceWorldName ?? sourceWorldEntry?.name ?? null
    : null;
  const sourceCreatorName =
    selectedItem.sourceCreatorName ?? sourceWorldEntry?.creatorName ?? null;
  const sourceCreatorId =
    selectedItem.sourceCreatorId ?? sourceWorldEntry?.creatorId ?? null;

  async function handleDelete() {
    setIsDeleting(true);
    const ok = await deleteWorld(selectedItem.id);
    setIsDeleting(false);
    setConfirmDelete(false);
    if (ok) {
      onBack();
      navigate({
        to: "/app/library",
        search: { worldId: undefined, view: undefined, assetId: undefined },
        replace: true,
      });
    }
  }

  // Inner duplicate request used by both the single-variant flow and the
  // VariantForkPicker. Surfaces the server's `error` field on non-OK so
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
        // R7: the confirm dialog is closing behind us, so there is no control
        // left to anchor the failure to.
        feedback.error(t("toast.failedToCopy"));
        return;
      }
      const { data: newWorld } = await res.json();
      // T0: the copy lands in My Projects (or the remix flow navigates into
      // it) — the new card is the confirmation.
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
      setConfirmCopy(false);
      setForkPickerOpen(false);
    }
  }

  // Confirm-dialog flow used when the world has no language group (single
  // variant): performs the copy directly against the selected world id.
  async function handleCopyToProject() {
    await performCopy(selectedItem.id);
  }

  // Entry point for the Edit/Fork button. When the world is part of a
  // language group with >1 variant we show a picker so the user can choose
  // which version to fork (and immediately see which ones the author has
  // locked). Otherwise we fall back to the simple confirmation dialog.
  async function handleEditClick() {
    if (!selectedItem.languageGroupId) {
      setConfirmCopy(true);
      return;
    }
    try {
      const res = await fetch(
        `${apiBase}/api/worlds/${selectedItem.id}/language-variants`,
        { credentials: "include" },
      );
      if (!res.ok) {
        setConfirmCopy(true);
        return;
      }
      const { data } = (await res.json()) as { data: LanguageVariant[] };
      if (!Array.isArray(data) || data.length <= 1) {
        setConfirmCopy(true);
        return;
      }
      // Single-forkable shortcut: skip the picker if exactly one variant is
      // forkable and the user doesn't own anything else in the group. Keeps
      // the common case (locked siblings, one main version) one click.
      const forkables = data.filter((v) => v.allowEdit !== false);
      const owned = userId ? data.filter((v) => v.creatorId === userId) : [];
      if (owned.length === 0 && forkables.length === 1) {
        await performCopy(forkables[0]!.id);
        return;
      }
      setForkVariants(data);
      setForkPickerOpen(true);
    } catch {
      // Network failure fetching variants — fall back to the simple flow
      // so the user can still attempt the copy on the variant they're on.
      setConfirmCopy(true);
    }
  }

  const isDraft = isProject && !selectedItem.isPublished;
  const { activityStats, reconcileFavoriteCount } = useActivityStats({
    apiBase,
    enabled: !isDraft && !isOrphanedFork,
    creatorAnalyticsEnabled: canViewCreatorAnalytics,
    worldId: selectedItem.id,
    downloadCount: selectedItem.downloadCount,
    messageCount: selectedItem.messageCount,
    favoriteCount: selectedItem.favoriteCount,
  });

  // Instant: the heart flips on the tap and the store syncs in the background,
  // so the count moves with it. If the server later refuses, the store puts
  // the heart back and shows the Retry pill itself.
  async function handleFavorite() {
    if (isProject) return;
    const worldId = selectedItem.sourceWorldId ?? selectedItem.id;
    const next = await toggleFavorite(worldId, {
      worldName: selectedItem.name,
      worldThumbnailUrl: selectedItem.thumbnailUrl,
    });
    reconcileFavoriteCount(next);
  }

  function getRelativeTime(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const hours = Math.floor(diff / 3600000);
    if (hours < 1) return t("time.justNow");
    if (hours < 24) return t("time.hoursAgo", { count: hours });
    const days = Math.floor(hours / 24);
    if (days === 1) return t("time.yesterday");
    if (days < 7) return t("time.daysAgo", { count: days });
    if (days < 30) return t("time.weeksAgo", { count: Math.floor(days / 7) });
    return t("time.monthsAgo", { count: Math.floor(days / 30) });
  }

  async function handlePlay() {
    // Pass the real languageGroupId so the session picker lists saves across
    // ALL variants in the group — the library card is dedup'd to one row per
    // language group (rep = earliest variant), so scoping the picker to just
    // the rep's worldId would hide the user's saves on later/sibling variants
    // (they'd only show via the hub). Keep them in sync.
    playWithLanguage(selectedItem);
  }

  function handleEdit(worldId?: string) {
    navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: worldId ?? selectedItem.id } });
  }

  async function handleDownloadJSON() {
    const variants = selectedItem.languageGroupId ? await fetchVariantsForDownload(selectedItem.id) : [];
    setDownloadVariants(variants);
    setDownloadPickerOpen(true);
  }

  async function handleShare() {
    const hubWorldId = selectedItem.sourceWorldId ?? selectedItem.id;
    const shareUrl = selectedItem.isPublished
      ? getWorldShareUrl(window.location.origin, hubWorldId, (selectedItem.schema.game as { path?: unknown } | undefined)?.path)
      : `${window.location.origin}/app/library?worldId=${encodeURIComponent(selectedItem.id)}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: selectedItem.name,
          text: `Check out ${selectedItem.name} on Yumina`,
          url: shareUrl,
        });
        return;
      }
      // R2: the share icon becomes a check for a beat instead of a pill.
      if (!(await copyShareLink(shareUrl))) throw new Error("clipboard");
    } catch {
      feedback.error(t("toast.failedToShare"));
    }
  }

  const tags = selectedItem.tags ?? (selectedItem.schema as Record<string, unknown>)?.tags as string[] | undefined;
  const lastActivityAt = !isProject ? libraryLastPlayedAt ?? selectedItem.updatedAt : selectedItem.updatedAt;
  const selectedItemCrop = normalizeWorldCoverCrop(selectedItem);

  // Orphaned fork — source world was unpublished
  if (isOrphanedFork) {
    return (
      <div
        ref={rootRef}
        data-scroll-restoration-id="library-detail"
        className="library-detail-root relative flex h-full w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden text-foreground"
      >
        <div className="relative z-10 h-[38rem] w-full shrink-0">
          <div className="absolute inset-x-0 top-0 h-[28rem] overflow-hidden rounded-[2.15rem] border border-white/10 bg-[#202024]">
            <button
              onClick={onBack}
              className="group absolute left-6 top-6 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white/80 shadow-lg backdrop-blur-md transition-all hover:bg-black/60 hover:text-white"
              title={isProject ? t("detail.backToProjects") : t("detail.backToGames")}
            >
              <ArrowLeft size={18} className="group-hover:-translate-x-0.5 transition-transform" />
            </button>

            {selectedItem.thumbnailUrl ? (
              <CroppedImage
                src={selectedItem.thumbnailUrl}
                alt={selectedItem.name}
                crop={selectedItemCrop.gallery}
                className="h-full w-full opacity-30 grayscale"
              />
            ) : (
              <div className="h-full w-full bg-[#212124] opacity-30" />
            )}
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
              <Lock size={48} className="text-white/30" />
            </div>
          </div>

          <div className="absolute inset-x-8 bottom-0 z-10">
            <div className="clouded-glass-panel clouded-glass-panel--strong rounded-[1.9rem] p-8">
              <h1 className="max-w-3xl text-5xl font-black leading-tight text-white/40 line-through drop-shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
                {selectedItem.name}
              </h1>
              <p className="mt-2 mb-5 text-sm text-muted-foreground/70">
                {t("detail.orphanedMessage")}
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleDownloadJSON}
                  className="flex h-12 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-6 text-sm font-medium text-white/70 transition-all hover:bg-white/10"
                >
                  <Download size={16} />
                  {t("detail.export")}
                </button>
                {canDelete && (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="flex h-12 items-center gap-2 rounded-lg border border-red-500/20 bg-red-900/20 px-6 text-sm font-medium text-red-400 transition-all hover:bg-red-900/40"
                  >
                    <Trash2 size={16} />
                    {t("detail.delete")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Delete confirmation dialog */}
        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent className="sm:max-w-[400px] bg-[#1A1A1D] border-white/10">
            <DialogHeader>
              <DialogTitle className="text-foreground">{t("dialog.deleteProject")}</DialogTitle>
              <DialogDescription dangerouslySetInnerHTML={{ __html: t("dialog.deleteConfirm", { name: escapeHtml(selectedItem.name) }) }} />
            </DialogHeader>
            <DialogFooter>
              <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors">{t("dialog.cancel")}</button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-4 py-2 text-sm bg-red-600 text-white font-medium rounded hover:bg-red-700 transition-colors flex items-center gap-2"
              >
                {isDeleting && <Loader2 size={14} className="animate-spin" />}
                {t("dialog.deleteAction")}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-scroll-restoration-id="library-detail"
      className="library-detail-root relative flex h-full w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden text-foreground"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-0"
        style={{
          height: "calc(var(--topbar-height) + 1rem)",
          transform: "translateY(calc(-1 * (var(--topbar-height) + 1rem)))",
        }}
      />

      {/* Hero Banner */}
      <div className="library-detail-hero relative z-10 w-full shrink-0 pb-[10rem]">
        <div className="library-detail-hero-media relative aspect-[16/5] min-h-[28rem] w-full overflow-hidden rounded-[2.15rem] border border-white/10 bg-[#202024]">
          <button
            onClick={onBack}
            className="library-detail-back-button group absolute left-6 top-6 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/40 text-white/80 shadow-lg backdrop-blur-md transition-all hover:bg-black/60 hover:text-white"
            title={isProject ? t("detail.backToProjects") : t("detail.backToGames")}
          >
            <ArrowLeft size={18} className="group-hover:-translate-x-0.5 transition-transform" />
          </button>

          {selectedItem.thumbnailUrl ? (
            <CroppedImage
              src={selectedItem.thumbnailUrl}
              alt={selectedItem.name}
              crop={selectedItemCrop.gallery}
              className="h-full w-full"
            />
          ) : (
            <div className="h-full w-full bg-[#212124]" />
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/34 via-black/10 to-transparent" />
        </div>

        <div className="library-detail-hero-content absolute inset-x-4 bottom-0 z-10 sm:inset-x-8">
          <div className="library-detail-hero-shell rounded-[1.9rem] px-4 pt-4 pb-6 sm:px-8">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h1 className="library-detail-title mb-0 max-w-3xl text-2xl font-black leading-tight text-white drop-shadow-[0_10px_30px_rgba(0,0,0,0.26)] sm:text-5xl">
                {selectedItem.name}
              </h1>
              {selectedItem.creatorId && features.socialProfiles ? (
                <button
                  type="button"
                  onClick={() => goToUser(selectedItem.creatorId)}
                  title={t("detail.viewCreatorProfile")}
                  className="hidden items-baseline gap-1.5 text-base font-medium text-white/65 transition-colors hover:text-white md:inline-flex"
                >
                  <span className="text-white/40">{t("detail.byAuthor")}</span>
                  <span className="max-w-[16rem] truncate">
                    {selectedItem.creatorName || t("detail.unknown")}
                  </span>
                </button>
              ) : (
                <span className="hidden items-baseline gap-1.5 text-base text-white/65 md:inline-flex">
                  <span className="text-white/40">{t("detail.byAuthor")}</span>
                  <span className="max-w-[16rem] truncate">
                    {selectedItem.creatorName || t("detail.unknown")}
                  </span>
                </span>
              )}
              {features.billing && (
              <SupportBadge
                creatorId={selectedItem.creatorId}
                creatorName={selectedItem.creatorName ?? undefined}
                worldId={selectedItem.id}
                worldName={selectedItem.name}
                currentUserId={userId}
                size="sm"
                className="hidden md:inline-flex"
              />
              )}
            </div>
            {sourceWorldName ? (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-white/72">
                <GitFork size={12} className="shrink-0" />
                <span>{t("detail.basedOn", { name: sourceWorldName })}</span>
                {sourceCreatorName ? (
                  <span className="text-white/40">
                    {t("detail.basedOnBy", { defaultValue: "by" })}{" "}
                    {sourceCreatorId && features.socialProfiles ? (
                      <button
                        onClick={() => goToUser(sourceCreatorId)}
                        className="text-white/72 underline-offset-2 hover:text-white hover:underline"
                      >
                        {sourceCreatorName}
                      </button>
                    ) : (
                      <span className="text-white/72">{sourceCreatorName}</span>
                    )}
                  </span>
                ) : null}
              </p>
            ) : null}

            {/* Play Bar */}
            <div className="library-detail-hero-bar mt-[1.625rem] flex flex-wrap items-center justify-between gap-2.5">
              <div className="library-detail-hero-main flex min-w-0 flex-wrap items-center gap-2.5 md:gap-6">
                <div className="library-detail-hero-buttons flex flex-wrap items-center gap-2.5">
                  <button
                    onClick={handlePlay}
                    disabled={false}
                    className="library-detail-primary-action flex h-14 items-center gap-2 rounded-lg bg-primary px-10 text-lg font-bold text-primary-foreground shadow-[0_0_20px_rgba(201,162,94,0.3)] transition-all hover:scale-105 hover:bg-primary/90 disabled:opacity-50"
                  >
                    <Play fill="currentColor" size={24} />
                    {t("detail.play")}
                  </button>
                  {canEditDirectly ? (
                    <button
                      onClick={() => handleEdit()}
                      className="library-detail-secondary-action flex h-14 items-center gap-2 rounded-lg bg-[#3B82F6] px-8 text-lg font-bold text-white/90 shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all hover:scale-105 hover:bg-[#3B82F6]/85"
                    >
                      <Pencil size={20} />
                      {t("detail.edit")}
                    </button>
                  ) : selectedItem.allowEdit !== false ? (
                    <button
                      onClick={handleEditClick}
                      className="library-detail-secondary-action flex h-14 items-center gap-2 rounded-lg bg-[#3B82F6] px-8 text-lg font-bold text-white/90 shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all hover:scale-105 hover:bg-[#3B82F6]/85"
                    >
                      <Pencil size={20} />
                      {t("detail.edit")}
                    </button>
                  ) : (
                    /* Guidance about a blocked action lives on the control: the
                       button is disabled and its tooltip explains why. */
                    <button
                      type="button"
                      disabled
                      title={t("dialog.authorDoesNotAllowEditing")}
                      className="library-detail-secondary-action flex h-14 cursor-not-allowed items-center gap-2 rounded-lg bg-[#3B82F6]/20 px-8 text-lg font-bold text-white/40"
                    >
                      <Lock size={20} />
                      {t("detail.edit")}
                    </button>
                  )}

                </div>

                {/* Stats */}
                <div className="library-detail-hero-stats flex min-w-0 flex-wrap items-center gap-4 border-l border-white/10 pl-4 md:gap-8 md:pl-8">
                  <div className="flex flex-col">
                    <span className="text-[11px] text-muted-foreground font-bold tracking-wider uppercase mb-1">
                      {isProject ? t("detail.lastEdited") : t("detail.lastPlayed")}
                    </span>
                    <span className="text-sm font-medium text-foreground">
                      {getRelativeTime(lastActivityAt)}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[11px] text-muted-foreground font-bold tracking-wider uppercase mb-1">
                      {t("detail.created")}
                    </span>
                    <span className="text-sm font-medium text-foreground">
                      {new Date(selectedItem.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {selectedItem.totalTokens != null && selectedItem.totalTokens > 0 && (
                    <div className="flex flex-col">
                      <span className="text-[11px] text-muted-foreground font-bold tracking-wider uppercase mb-1">
                        {t("detail.tokens")}
                      </span>
                      <span className="text-sm font-medium text-foreground">
                        ~{selectedItem.totalTokens.toLocaleString()}
                      </span>
                    </div>
                  )}
                  {selectedItem.approxTime && (
                    <div className="flex flex-col">
                      <span className="text-[11px] text-muted-foreground font-bold tracking-wider uppercase mb-1">
                        {t("detail.estTime")}
                      </span>
                      <span className="text-sm font-medium text-foreground">
                        {selectedItem.approxTime}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="library-detail-hero-icons flex items-center gap-2">
                {features.hub && (
                <button
                  onClick={() => void handleShare()}
                  className="text-muted-foreground hover:text-primary hover:bg-white/10 rounded-full p-2 transition-colors"
                  title={shareCopied ? t("toast.linkCopied") : t("detail.share")}
                >
                  {shareCopied ? <Check size={20} className="text-primary" /> : <Share2 size={20} />}
                </button>
                )}
                {(canEditDirectly || selectedItem.allowEdit !== false) && (
                  <button
                    onClick={handleDownloadJSON}
                    className="text-muted-foreground hover:text-primary hover:bg-white/10 rounded-full p-2 transition-colors"
                    title={t("detail.download")}
                  >
                    <Download size={20} />
                  </button>
                )}
                <button
                  onClick={() => setSessionExportOpen(true)}
                  className="text-muted-foreground hover:text-primary hover:bg-white/10 rounded-full p-2 transition-colors"
                  title={t("detail.sessionExport.triggerTitle")}
                >
                  <FileText size={20} />
                </button>
                <button
                  onClick={() => setSharePickerOpen(true)}
                  className="rounded-full p-2 text-primary/80 transition-colors hover:bg-primary/10 hover:text-primary"
                  title={t("detail.sharePlaythrough")}
                >
                  <Clapperboard size={20} />
                </button>
                {!isProject && (
                  <button
                    onClick={() => setShowReport(true)}
                    className="text-muted-foreground hover:text-destructive hover:bg-white/10 rounded-full p-2 transition-colors"
                    title={t("detail.report")}
                  >
                    <Flag size={20} />
                  </button>
                )}
                {canDelete && (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-full p-2 transition-colors"
                    title={t("detail.delete")}
                  >
                    <Trash2 size={20} />
                  </button>
                )}
                {!isProject && (
                  <button
                    onClick={() => void handleFavorite()}
                    className={`hover:bg-white/10 rounded-full p-2 transition-colors ${favorited ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
                    title={favorited ? t("detail.removeFromFavorites") : t("detail.addToFavorites")}
                  >
                    <Heart size={20} fill={favorited ? "currentColor" : "none"} />
                  </button>
                )}
                {selectedItem.creatorId && features.socialProfiles ? (
                  <button
                    onClick={() => goToUser(selectedItem.creatorId)}
                    title={t("detail.viewCreatorProfile")}
                    className="group inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:border-primary/40 hover:bg-primary/[0.08] hover:text-primary md:hidden"
                  >
                    <span className="text-muted-foreground/70 group-hover:text-primary/70">
                      {t("detail.byAuthor")}
                    </span>
                    <span className="max-w-[10rem] truncate font-medium">
                      {selectedItem.creatorName || t("detail.unknown")}
                    </span>
                  </button>
                ) : (
                  <span className="inline-flex max-w-[12rem] items-center truncate rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-foreground/80 md:hidden">
                    {selectedItem.creatorName || t("detail.unknown")}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content Area */}
      {isDraft ? (
        <div className="p-8">
          <div className="clouded-glass-panel rounded-xl p-6">
            <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-foreground">
              <FileText size={18} className="text-primary" />
              {t("detail.projectDetails")}
            </h2>
            {selectedItem.description ? (
              <WorldDescription
                content={selectedItem.description}
                className="mb-6 text-sm leading-relaxed text-foreground/70"
              />
            ) : (
              <p className="mb-6 text-sm leading-relaxed text-foreground/70">
                {t("detail.noDescriptionYet")}
              </p>
            )}
            <div className="clouded-glass-inset mb-6 rounded-lg p-4">
              <h3 className="text-sm font-bold text-muted-foreground mb-2">
                {t("detail.developmentStatus")}
              </h3>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-sm text-foreground">{t("detail.activeDevelopment")}</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="library-detail-content relative z-20 flex min-w-0 gap-7 px-4 pb-10 pt-5 sm:px-8">
          <div className="library-detail-main min-w-0 flex-1">
            <div className="library-detail-card clouded-glass-panel clouded-glass-panel--soft relative overflow-hidden rounded-xl p-6 md:p-7">
              {!location.pathname.startsWith("/app/library") && <div className="absolute inset-0 bg-black/25" />}

              <div className="relative z-10 flex flex-wrap items-start justify-between gap-4 border-b border-white/8 pb-5">
                <div>
                  <h2 className="text-lg font-bold flex items-center gap-2 text-foreground">
                    <FileText size={18} className="text-primary" />
                    {t("detail.overview")}
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-foreground/80">
                    {isProject ? t("detail.project") : t("detail.game")}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-foreground/80">
                    {isDraft ? t("detail.draft") : t("detail.published")}
                  </span>
                </div>
              </div>

              <div className="relative z-10 mt-5 space-y-5">
                {selectedItem.announcement && (
                  <div className="clouded-glass-inset rounded-lg p-5">
                    <div className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-primary/80">
                      {t("detail.announcement")}
                    </div>
                    <p className="text-sm leading-relaxed text-foreground/80 whitespace-pre-line">
                      {selectedItem.announcement}
                    </p>
                    <span className="mt-3 block text-xs font-medium text-muted-foreground/60">
                      {t("detail.created")} {new Date(selectedItem.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                )}

                <div className="clouded-glass-inset rounded-lg p-5">
                  <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground/70">
                    {t("detail.about")}
                  </div>
                  {selectedItem.description ? (
                    <WorldDescription
                      content={selectedItem.description}
                      className="mt-3 text-sm leading-relaxed text-foreground/72"
                    />
                  ) : (
                    <p className="mt-3 text-sm leading-relaxed text-foreground/72">
                      {t("detail.noDescriptionAvailable")}
                    </p>
                  )}
                </div>

                {tags && tags.length > 0 && (
                  <div className="border-t border-white/8 pt-5">
                    <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground/70">
                      {t("detail.tags")}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-primary/20 hover:text-primary"
                        >
                          {resolveTagLabel(tag)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <LibraryDetailActivityCard
              layout="desktop"
              showCreatorMetrics={canViewCreatorAnalytics}
              stats={activityStats}
            />

            {/* Reviews — inline so players can read/leave comments without
                going back out to Discover. Only for published cards that
                keep reviews open; drafts/orphans never reach this branch. */}
            {features.reviews && selectedItem.isPublished && selectedItem.allowReviews !== false && (
              <div className="library-detail-card clouded-glass-panel clouded-glass-panel--soft relative mt-7 overflow-hidden rounded-xl p-6 md:p-7">
                <div className="relative z-10">
                  <h2 className="mb-5 flex items-center gap-2 border-b border-white/8 pb-5 text-lg font-bold text-foreground">
                    <MessagesSquare size={18} className="text-primary" />
                    {t("detail.reviews")}
                  </h2>
                  <WorldReviewsSection
                    worldId={selectedItem.id}
                    allowReviews={selectedItem.allowReviews ?? true}
                    isWorldCreator={!!userId && selectedItem.creatorId === userId}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Edit as My Project dialog */}
      <Dialog open={confirmCopy} onOpenChange={(open) => { if (!open) setConfirmCopy(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dialog.editAsMyProject")}</DialogTitle>
            <DialogDescription dangerouslySetInnerHTML={{ __html: t("dialog.editAsMyProjectDesc", { creator: escapeHtml(selectedItem.creatorName || t("detail.unknown")), name: escapeHtml(selectedItem.name) }) }} />
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setConfirmCopy(false)}
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

      {showReport && (
        <ReportDialog
          worldId={selectedItem.id}
          targetName={selectedItem.name}
          open={showReport}
          onClose={() => setShowReport(false)}
        />
      )}

      <VariantDownloadPicker
        open={downloadPickerOpen}
        onClose={() => setDownloadPickerOpen(false)}
        worldId={selectedItem.id}
        variants={downloadVariants}
        worldName={selectedItem.name?.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}
      />

      <VariantForkPicker
        open={forkPickerOpen}
        onClose={() => setForkPickerOpen(false)}
        variants={forkVariants}
        currentUserId={userId}
        worldName={selectedItem.name}
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

      <SessionExportModal
        worldId={selectedItem.id}
        worldName={selectedItem.name}
        languageGroupId={selectedItem.languageGroupId}
        open={sessionExportOpen}
        onClose={() => setSessionExportOpen(false)}
      />

      <SharePlaythroughPicker
        worldId={selectedItem.id}
        worldName={selectedItem.name}
        languageGroupId={selectedItem.languageGroupId}
        open={sharePickerOpen}
        onClose={() => setSharePickerOpen(false)}
        onPick={(sessionId, title, worldId) => {
          setSharePickerOpen(false);
          // Keep the session's OWN worldId — the picker lists saves across the
          // whole language group, so a chosen save may live on a sibling
          // variant, not selectedItem (the group's rep). The publish endpoint
          // requires session.worldId === path worldId, so passing the rep here
          // would 404 with "Session not found".
          setShareSession({ id: sessionId, title, worldId });
        }}
      />

      <SharePlaythroughModal
        open={!!shareSession}
        worldId={shareSession?.worldId ?? selectedItem.id}
        sessionId={shareSession?.id ?? ""}
        defaultTitle={shareSession?.title ?? selectedItem.name}
        onClose={() => setShareSession(null)}
        onShared={() => {
          const sharedWorldId = shareSession?.worldId ?? selectedItem.id;
          setShareSession(null);
          // Open the card's playthroughs tab here so the player sees
          // their freshly-shared run listed. Use the session's own world (where
          // the playthrough was created), not the group rep, so the share is
          // actually visible there (playthroughs are scoped per-variant).
          if (selectedItem.isPublished && features.hub) {
            void openWorldPreview(sharedWorldId, { tab: "playthroughs" });
          }
        }}
      />

      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 size={18} className="text-red-400" />
              {isProject ? t("dialog.deleteProject") : t("dialog.deleteGame")}
            </DialogTitle>
            <DialogDescription dangerouslySetInnerHTML={{ __html: t("dialog.deleteConfirm", { name: escapeHtml(selectedItem.name) }) }} />
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={isDeleting}
              className="px-4 py-2 text-sm text-muted-foreground hover:bg-muted rounded transition-colors"
            >
              {t("dialog.cancel")}
            </button>
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="px-4 py-2 text-sm bg-red-600 text-white font-medium rounded hover:bg-red-700 transition-colors flex items-center gap-2"
            >
              {isDeleting && <Loader2 size={14} className="animate-spin" />}
              {t("dialog.deleteAction")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
