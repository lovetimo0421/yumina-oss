import { useOpenWorldPreview } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { getUserProfileHref } from "@/edition/routes";
import { getWorldShareUrl } from "@/edition/slots.state";
import { useStoryNavigation } from "@/hooks/use-story-navigation";
import { useEffect, useRef, useState } from "react";
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
  Ellipsis,
  UserRound,
  ImageOff,
  ChevronDown,
  History,
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useActivityStats } from "@/lib/library-detail-stats";
import { SessionExportModal } from "./session-export-modal";
import { SharePlaythroughModal } from "@/features/chat/share-playthrough-modal";
import { SharePlaythroughPicker } from "./share-playthrough-picker";
import { SupportBadge } from "@/edition/slots";
import { WorldReviewsSection } from "@/edition/slots";
import { LibraryDetailActivityCard } from "./library-detail-activity-card";
import { WorldUpdateHistory } from "./world-update-history";

const apiBase = import.meta.env.VITE_API_URL || "";

interface LibraryDetailPanelProps {
  selectedItem: WorldItem;
  allItems: WorldItem[];
  onSelectItem: (item: WorldItem) => void;
  onBack: () => void;
  isProject?: boolean;
  onRemixComplete?: (newWorld: WorldItem) => void;
  userId?: string;
}

export function LibraryDetailPanelMobile({
  selectedItem,
  onBack,
  isProject,
  onRemixComplete,
  userId,
}: LibraryDetailPanelProps) {
  const { t } = useTranslation("library");
  const { t: tCommon } = useTranslation("common");
  const { copy: copyShareLink } = useCopyFeedback();
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
  const [downloadPreparing, setDownloadPreparing] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [heroImageFailed, setHeroImageFailed] = useState(false);
  const navigateToStory = useStoryNavigation();
  const { openWorldPreview } = useOpenWorldPreview();
  const { features } = useEdition();
  const goToUser = (userId: string) => {
    const href = getUserProfileHref(userId);
    if (href) void navigate({ to: href });
  };
  const { handlePlay: playWithLanguage, loading: playLoading } = usePlayWithLanguage({
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

  const deleteDialog = (
    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={setConfirmDelete}
      title={isProject ? t("dialog.deleteProject") : t("games.removeFromLibrary")}
      descriptionHtml={isProject
        ? t("dialog.deleteIrreversible")
        : t("games.removeConfirm", { name: escapeHtml(selectedItem.name) })}
      confirmLabel={isProject
        ? t(selectedItem.isPublished ? "dialog.deletePermanently" : "dialog.deleteAction")
        : t("games.removeAction")}
      cancelLabel={t("dialog.cancel")}
      onConfirm={handleDelete}
      busy={isDeleting}
      item={{
        name: selectedItem.name,
        detail: isProject ? t("tabs.myProjects") : t("tabs.games"),
        imageUrl: selectedItem.thumbnailUrl,
      }}
      consequences={[]}
    />
  );

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
    await playWithLanguage(selectedItem);
  }

  function handleEdit(worldId?: string) {
    navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: worldId ?? selectedItem.id } });
  }

  async function handleDownloadJSON() {
    if (downloadPreparing) return;
    // T0: the Export button already spins and is aria-busy while this runs, and
    // the variant picker opening is the result — the loading pill said nothing.
    setDownloadPreparing(true);
    try {
      const variants = selectedItem.languageGroupId ? await fetchVariantsForDownload(selectedItem.id) : [];
      setDownloadVariants(variants);
      setDownloadPickerOpen(true);
    } catch {
      feedback.error(t("toast.failedToDownload"));
    } finally {
      setDownloadPreparing(false);
    }
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
      // Share lives in the "…" dropdown, which closes on select — nothing on
      // screen changes, so this one copy still gets a word (a plain notice).
      if (!(await copyShareLink(shareUrl))) throw new Error("clipboard");
      feedback.notice(t("toast.linkCopied"));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      feedback.error(t("toast.failedToShare"));
    }
  }

  // R1: the heart fills the moment it's tapped and never locks — tap again and
  // it flips again, like any like button. The store syncs in the background
  // and, if the server refuses, puts the heart back and shows the Retry pill.
  async function handleFavorite() {
    if (isProject) return;
    const worldId = selectedItem.sourceWorldId ?? selectedItem.id;
    const next = await toggleFavorite(worldId, {
      worldName: selectedItem.name,
      worldThumbnailUrl: selectedItem.thumbnailUrl,
    });
    reconcileFavoriteCount(next);
  }

  function handleCreatorProfile() {
    if (!selectedItem.creatorId) return;
    goToUser(selectedItem.creatorId);
  }

  const tags = selectedItem.tags ?? (selectedItem.schema as Record<string, unknown>)?.tags as string[] | undefined;
  const lastActivityAt = !isProject ? libraryLastPlayedAt ?? selectedItem.updatedAt : selectedItem.updatedAt;
  const description = selectedItem.description || (isDraft ? t("detail.noDescriptionYet") : t("detail.noDescriptionAvailable"));
  const descriptionIsLong = description.length > 420 || description.split(/\r?\n/).length > 6;
  const canDownload = canEditDirectly || selectedItem.allowEdit !== false;
  // File-system control characters are invalid in download names.
  // eslint-disable-next-line no-control-regex
  const safeDownloadWorldName = selectedItem.name?.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const mobileDropdownItemClass = "min-h-12 rounded-xl px-3 text-sm font-medium focus:bg-white/[0.08] focus:text-foreground data-[disabled]:opacity-50";

  useEffect(() => {
    setDescriptionExpanded(false);
    setHeroImageFailed(false);
  }, [selectedItem.id]);

  const secondaryActionLabel = canEditDirectly
    ? t("detail.edit")
    : selectedItem.allowEdit !== false
      ? t("dialog.createCopy")
      : t("dialog.authorDoesNotAllowEditing");
  const SecondaryActionIcon = canEditDirectly
    ? Pencil
    : selectedItem.allowEdit !== false
      ? GitFork
      : Lock;

  // The blocked case is already spelled out on the control itself — a Lock icon
  // and the label "The author doesn't allow editing" — and the button below is
  // disabled, so there is nothing left for a pill to say.
  const secondaryActionBlocked = !canEditDirectly && selectedItem.allowEdit === false;

  function handleSecondaryAction() {
    if (canEditDirectly) handleEdit();
    else if (!secondaryActionBlocked) void handleEditClick();
  }

  function renderMobilePrimaryActions() {
    return (
      <div className="grid w-full grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void handlePlay()}
          disabled={playLoading}
          aria-busy={playLoading}
          className="inline-flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold leading-tight text-primary-foreground shadow-[0_8px_24px_rgba(201,162,94,0.2)] transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait disabled:opacity-65 motion-reduce:transition-none md:min-w-44"
        >
          {playLoading ? (
            <Loader2 className="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Play className="h-5 w-5 shrink-0" fill="currentColor" aria-hidden="true" />
          )}
          <span>{t("detail.play")}</span>
        </button>
        <button
          type="button"
          onClick={handleSecondaryAction}
          disabled={secondaryActionBlocked}
          className="inline-flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-xl border border-white/16 bg-white/[0.035] px-5 py-2.5 text-sm font-semibold leading-tight text-foreground transition-colors hover:border-white/28 hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-white/16 disabled:hover:bg-white/[0.035] motion-reduce:transition-none md:min-w-36"
        >
          <SecondaryActionIcon className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
          <span>{secondaryActionLabel}</span>
        </button>
      </div>
    );
  }

  // Orphaned fork — source world was unpublished
  if (isOrphanedFork) {
    return (
      <div
        ref={rootRef}
        data-scroll-restoration-id="library-detail"
        className="library-detail-root relative flex h-full w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden text-foreground"
      >
          <div>
          <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-muted sm:aspect-[3/2]">
          {selectedItem.thumbnailUrl && !heroImageFailed ? (
            <CroppedImage
              src={selectedItem.thumbnailUrl}
              alt={selectedItem.name}
              width={1280}
              placeholder
              loading="eager"
              fetchPriority="high"
              onError={() => setHeroImageFailed(true)}
              className="absolute inset-0 h-full w-full opacity-35 grayscale"
              imgClassName="object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-muted" />
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/55">
            <Lock className="h-12 w-12 text-white/45" aria-hidden="true" />
          </div>
          <button
            type="button"
            onClick={onBack}
            aria-label={tCommon("action.back")}
            title={tCommon("action.back")}
            className="absolute left-4 top-4 z-20 inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white shadow-lg transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-black motion-reduce:transition-none"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          </div>

          <div className="mx-auto w-full px-4 py-6">
            <h1 className="break-words text-[28px] font-black leading-[1.16] tracking-[-0.02em] text-foreground/65 line-through">
              {selectedItem.name}
            </h1>
            <p className="mt-3 max-w-3xl text-base leading-[1.6] text-muted-foreground">
              {t("detail.orphanedMessage")}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void handleDownloadJSON()}
                disabled={downloadPreparing}
                aria-busy={downloadPreparing}
                className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-white/16 bg-white/[0.035] px-5 text-sm font-semibold text-foreground transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
              >
                {downloadPreparing ? (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                ) : (
                  <Download className="h-4 w-4" aria-hidden="true" />
                )}
                {t("detail.export")}
              </button>
              {canDelete && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-red-400/20 bg-red-500/8 px-5 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 motion-reduce:transition-none"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t("detail.delete")}
                </button>
              )}
            </div>
          </div>
          </div>

        <VariantDownloadPicker
          open={downloadPickerOpen}
          onClose={() => setDownloadPickerOpen(false)}
          worldId={selectedItem.id}
          variants={downloadVariants}
          worldName={safeDownloadWorldName}
        />

        {deleteDialog}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-scroll-restoration-id="library-detail"
      className="library-detail-root relative flex h-full w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden text-foreground"
    >
        <div className="flex flex-col">
        {/* A taller mobile gallery reveals more of the original cover while reserving space before load. */}
        <div className="relative z-10 aspect-[4/3] w-full shrink-0 overflow-hidden bg-muted sm:aspect-[3/2]">
        {selectedItem.thumbnailUrl && !heroImageFailed ? (
          <CroppedImage
            src={selectedItem.thumbnailUrl}
            alt={selectedItem.name}
            width={1280}
            placeholder
            loading="eager"
            fetchPriority="high"
            onError={() => setHeroImageFailed(true)}
            className="absolute inset-0 h-full w-full"
            imgClassName="object-cover"
          />
        ) : (
          <div
            role="img"
            aria-label={selectedItem.name}
            className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted via-background to-muted"
          >
            <ImageOff className="h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
          </div>
        )}

        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/55 to-transparent" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/45 to-transparent" />

        <button
          type="button"
          onClick={onBack}
          aria-label={tCommon("action.back")}
          title={tCommon("action.back")}
          className="group absolute left-4 top-4 z-20 inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white shadow-lg transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-black motion-reduce:transition-none"
        >
          <ArrowLeft className="h-5 w-5 transition-transform group-hover:-translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none" aria-hidden="true" />
        </button>

        {!isProject && (
          <div className="absolute right-4 top-4 z-20">
            <button
              type="button"
              onClick={() => void handleFavorite()}
              aria-pressed={favorited}
              aria-label={favorited ? t("detail.removeFromFavorites") : t("detail.addToFavorites")}
              title={favorited ? t("detail.removeFromFavorites") : t("detail.addToFavorites")}
              className={`inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-black/50 shadow-lg transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-black motion-reduce:transition-none ${favorited ? "text-primary" : "text-white"}`}
            >
              <Heart className="h-5 w-5" fill={favorited ? "currentColor" : "none"} aria-hidden="true" />
            </button>
          </div>
        )}
        </div>

        <div className="library-detail-content-shell relative z-20 mx-auto -mt-3 w-full px-4 pb-28">
        <section aria-labelledby="library-detail-title" className="library-detail-mobile-surface rounded-2xl">
          <div className="px-3 py-3">
            <div className="min-w-0">
              {isDraft && (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary/90">
                  {t("detail.draft")}
                </div>
              )}
              <div className="flex min-w-0 items-start gap-3">
                <h1 id="library-detail-title" className="min-w-0 flex-1 break-words text-[28px] font-black leading-[1.16] tracking-[-0.02em] text-foreground md:text-4xl">
                  {selectedItem.name}
                </h1>
                <div className="flex shrink-0 items-center gap-2">
                  {features.billing && (
                  <SupportBadge
                    creatorId={selectedItem.creatorId}
                    creatorName={selectedItem.creatorName ?? undefined}
                    worldId={selectedItem.id}
                    worldName={selectedItem.name}
                    currentUserId={userId}
                    size="sm"
                    className="min-h-12 shrink-0 px-3"
                  />
                  )}
                  <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={tCommon("dm.moreActions")}
                      title={tCommon("dm.moreActions")}
                      className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.035] text-foreground shadow-sm transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
                    >
                      <Ellipsis className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    side="bottom"
                    sideOffset={8}
                    collisionPadding={12}
                    className="library-detail-actions-dropdown w-64 rounded-2xl border-white/12 p-2 shadow-2xl motion-reduce:animate-none"
                  >
                    {features.hub && (
                    <DropdownMenuItem onSelect={() => void handleShare()} className={mobileDropdownItemClass}>
                      <Share2 aria-hidden="true" />
                      <span>{t("detail.share")}</span>
                    </DropdownMenuItem>
                    )}
                    {canDownload && (
                      <DropdownMenuItem
                        onSelect={() => void handleDownloadJSON()}
                        disabled={downloadPreparing}
                        className={mobileDropdownItemClass}
                      >
                        {downloadPreparing ? (
                          <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        ) : (
                          <Download aria-hidden="true" />
                        )}
                        <span>{t("detail.download")}</span>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setSessionExportOpen(true)} className={mobileDropdownItemClass}>
                      <FileText aria-hidden="true" />
                      <span>{t("detail.sessionExport.triggerTitle")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setSharePickerOpen(true)} className={mobileDropdownItemClass}>
                      <Clapperboard aria-hidden="true" />
                      <span>{t("detail.sharePlaythrough")}</span>
                    </DropdownMenuItem>
                    {selectedItem.creatorId && features.socialProfiles && (
                      <DropdownMenuItem onSelect={handleCreatorProfile} className={mobileDropdownItemClass}>
                        <UserRound aria-hidden="true" />
                        <span>{t("detail.viewCreatorProfile")}</span>
                      </DropdownMenuItem>
                    )}
                    {(!isProject || canDelete) && <DropdownMenuSeparator className="my-2 bg-red-400/15" />}
                    {!isProject && (
                      <DropdownMenuItem
                        onSelect={() => setShowReport(true)}
                        className={`${mobileDropdownItemClass} text-red-300 focus:bg-red-500/12 focus:text-red-200`}
                      >
                        <Flag aria-hidden="true" />
                        <span>{t("detail.report")}</span>
                      </DropdownMenuItem>
                    )}
                    {canDelete && (
                      <DropdownMenuItem
                        onSelect={() => setConfirmDelete(true)}
                        className={`${mobileDropdownItemClass} text-red-300 focus:bg-red-500/12 focus:text-red-200`}
                      >
                        <Trash2 aria-hidden="true" />
                        <span>{t("detail.delete")}</span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-6">
                <span className="shrink-0 text-muted-foreground">{t("detail.byAuthor")}</span>
                {selectedItem.creatorId && features.socialProfiles ? (
                  <button
                    type="button"
                    onClick={handleCreatorProfile}
                    className="min-w-0 break-words text-left font-semibold text-foreground underline decoration-white/25 underline-offset-4 transition-colors hover:text-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
                  >
                    {selectedItem.creatorName || t("detail.unknown")}
                  </button>
                ) : (
                  <span className="min-w-0 break-words font-semibold text-foreground">{selectedItem.creatorName || t("detail.unknown")}</span>
                )}
              </div>
            </div>
          </div>

          {sourceWorldName && (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-white/8 px-3 py-3 text-sm leading-6 text-muted-foreground">
              <GitFork className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="break-words">{t("detail.basedOn", { name: sourceWorldName })}</span>
              {sourceCreatorName && (
                <span className="flex flex-wrap gap-1">
                  <span>{t("detail.basedOnBy", { defaultValue: "by" })}</span>
                  {sourceCreatorId && features.socialProfiles ? (
                    <button
                      type="button"
                      onClick={() => goToUser(sourceCreatorId)}
                      className="break-words text-left font-medium text-foreground underline decoration-white/25 underline-offset-4 transition-colors hover:text-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
                    >
                      {sourceCreatorName}
                    </button>
                  ) : (
                    <span className="break-words font-medium text-foreground">{sourceCreatorName}</span>
                  )}
                </span>
              )}
            </p>
          )}

          <dl className="grid grid-cols-3 divide-x divide-white/8 border-t border-white/8">
            <div className="min-w-0 p-2 text-center sm:p-4">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {isProject ? t("detail.lastEdited") : t("detail.lastPlayed")}
              </dt>
              <dd className="mt-1.5 break-words text-sm font-semibold tabular-nums text-foreground sm:text-base">
                {getRelativeTime(lastActivityAt)}
              </dd>
            </div>
            <div className="min-w-0 p-2 text-center sm:p-4">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t("detail.created")}
              </dt>
              <dd className="mt-1.5 break-words text-sm font-semibold tabular-nums text-foreground sm:text-base">
                {new Date(selectedItem.createdAt).toLocaleDateString()}
              </dd>
            </div>
            <div className="min-w-0 p-2 text-center sm:p-4">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t("detail.tokens")}
              </dt>
              <dd className="mt-1.5 break-words text-sm font-semibold tabular-nums text-foreground sm:text-base">
                {selectedItem.totalTokens != null ? `~${selectedItem.totalTokens.toLocaleString()}` : "—"}
              </dd>
            </div>
            {selectedItem.approxTime && (
              <div className="col-span-3 flex items-center justify-between gap-4 border-t border-white/8 px-3 py-2.5 sm:px-4">
                <dt className="text-xs font-medium text-muted-foreground">{t("detail.estTime")}</dt>
                <dd className="text-sm font-semibold tabular-nums text-foreground">{selectedItem.approxTime}</dd>
              </div>
            )}
          </dl>
        </section>

        {isDraft ? (
          <section aria-labelledby="project-details-heading" className="library-detail-mobile-surface mt-8 rounded-2xl p-4">
            <h2 id="project-details-heading" className="flex items-center gap-2 text-xl font-bold text-foreground">
              <FileText className="h-5 w-5 text-primary" aria-hidden="true" />
              {t("detail.projectDetails")}
            </h2>
            {selectedItem.description ? (
              <WorldDescription
                content={selectedItem.description}
                className="mt-4 text-base leading-[1.6] text-foreground/80"
              />
            ) : (
              <p className="mt-4 text-base leading-[1.6] text-foreground/80">{description}</p>
            )}
            <div className="mt-6 rounded-xl border border-white/8 bg-white/[0.035] p-4">
              <h3 className="text-sm font-bold text-muted-foreground">{t("detail.developmentStatus")}</h3>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden="true" />
                <span className="text-sm text-foreground">{t("detail.activeDevelopment")}</span>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section aria-labelledby="overview-heading" className="library-detail-mobile-surface mt-8 rounded-2xl p-4">
              <h2 id="overview-heading" className="flex items-center gap-2 text-xl font-bold text-foreground">
                <FileText className="h-5 w-5 text-primary" aria-hidden="true" />
                {t("detail.overview")}
              </h2>

              {selectedItem.announcement && (
                <div className="mt-5 rounded-xl border border-white/8 bg-white/[0.035] p-4">
                  <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-primary">{t("detail.announcement")}</h3>
                  <p className="mt-2 whitespace-pre-line text-base leading-[1.6] text-foreground/80">{selectedItem.announcement}</p>
                  <span className="mt-3 block text-xs font-medium text-muted-foreground">
                    {t("detail.created")} {new Date(selectedItem.createdAt).toLocaleDateString()}
                  </span>
                </div>
              )}

              <div className="mt-5">
                <h3 className="text-sm font-bold text-muted-foreground">{t("detail.about")}</h3>
                {selectedItem.description ? (
                  // Markdown renders block children, so `-webkit-line-clamp`
                  // (which needs display:-webkit-box) would mangle the layout.
                  // Clip by height instead and let "load more" reveal the rest.
                  <div className={descriptionIsLong && !descriptionExpanded ? "max-h-60 overflow-hidden" : undefined}>
                    <WorldDescription
                      content={selectedItem.description}
                      className="mt-3 text-base leading-[1.6] text-foreground/80"
                    />
                  </div>
                ) : (
                  <p className="mt-3 text-base leading-[1.6] text-foreground/80">{description}</p>
                )}
                {descriptionIsLong && !descriptionExpanded && (
                  <button
                    type="button"
                    onClick={() => setDescriptionExpanded(true)}
                    aria-expanded={descriptionExpanded}
                    className="mt-3 inline-flex min-h-12 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
                  >
                    {tCommon("dm.loadMore")}
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>

              {tags && tags.length > 0 && (
                <div className="mt-6 border-t border-white/8 pt-5">
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">{t("detail.tags")}</h3>
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => (
                      <span key={tag} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-muted-foreground">
                        {resolveTagLabel(tag)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <LibraryDetailActivityCard
              layout="mobile"
              showCreatorMetrics={canViewCreatorAnalytics}
              stats={activityStats}
            />

            {selectedItem.isPublished && (
              <section aria-labelledby="update-history-heading" className="library-detail-mobile-surface mt-4 rounded-2xl p-4">
                <h2 id="update-history-heading" className="mb-5 flex items-center gap-2 border-b border-white/8 pb-5 text-base font-bold text-foreground">
                  <History className="h-5 w-5 text-primary" aria-hidden="true" />
                  {t("detail.updateHistory")}
                </h2>
                <WorldUpdateHistory worldId={selectedItem.id} creatorName={selectedItem.creatorName} />
              </section>
            )}

            {features.reviews && selectedItem.isPublished && selectedItem.allowReviews !== false && (
              <section aria-labelledby="reviews-heading" className="library-detail-mobile-surface mt-4 rounded-2xl p-4">
                <h2 id="reviews-heading" className="mb-5 flex items-center gap-2 border-b border-white/8 pb-5 text-xl font-bold text-foreground">
                  <MessagesSquare className="h-5 w-5 text-primary" aria-hidden="true" />
                  {t("detail.reviews")}
                </h2>
                <div
                  role="region"
                  aria-label={t("detail.reviewsScrollableLabel")}
                  tabIndex={0}
                  className="max-h-[32rem] overflow-y-auto pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 [scrollbar-gutter:stable]"
                >
                  <WorldReviewsSection
                    worldId={selectedItem.id}
                    allowReviews={selectedItem.allowReviews ?? true}
                    isWorldCreator={!!userId && selectedItem.creatorId === userId}
                  />
                </div>
              </section>
            )}
          </>
        )}
        </div>

        <div className="library-detail-mobile-cta sticky bottom-0 z-40 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
          {renderMobilePrimaryActions()}
        </div>
        </div>

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
              className="min-h-12 rounded-xl px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:min-h-0 md:rounded"
            >
              {t("dialog.cancel")}
            </button>
            <button
              onClick={handleCopyToProject}
              disabled={copying}
              className="flex min-h-12 items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 md:min-h-0 md:rounded md:bg-[#3B82F6] md:text-white md:hover:bg-[#3B82F6]/85"
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
        worldName={safeDownloadWorldName}
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

      {deleteDialog}
    </div>
  );
}
