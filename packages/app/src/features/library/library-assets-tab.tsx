import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import {
  FileText,
  File as FileIcon,
  Image,
  Music4,
  Type,
  Download,
  Trash2,
  Folder,
  FolderOpen,
  FolderPlus,
  Copy,
  Link,
  ChevronRight,
  ChevronLeft,
  Upload,
  Pencil,
  HardDrive,
  Loader2,
  Check,
} from "lucide-react";
import {
  useUserAssetStore,
  type UserAsset,
  type AssetFolder,
} from "@/stores/user-assets";
import { useFolderBindingStore } from "@/stores/folder-bindings";
import { useWorldsStore } from "@/stores/worlds";
import { useSession } from "@/lib/auth-client";
import { Link2, X, Check as CheckIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { getAssetCdnUrl, cardImageUrl, fallbackToOriginalOnError } from "@/lib/asset-url";
import { getUploadMetadata } from "@/lib/asset-upload";
import { LibraryEmptyState } from "./library-empty-state";
import { BulkActionsBar } from "./bulk-actions-bar";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { ImagePlus } from "lucide-react";
import { useFeature } from "@/edition/edition";
import { GenerationPanel } from "@/edition/slots";

// ─── Helpers ────────────────────────────────────────────────────────

function formatSize(bytes: number | null) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getAssetIcon(type: string, size = 24) {
  switch (type) {
    case "image":
      return <Image size={size} />;
    case "audio":
      return <Music4 size={size} />;
    case "font":
      return <Type size={size} />;
    case "txt":
      return <FileText size={size} />;
    default:
      return <FileIcon size={size} />;
  }
}

function isTextAsset(asset: UserAsset | null): asset is UserAsset {
  return !!asset && (asset.type === "txt" || !!asset.mimeType?.startsWith("text/"));
}

const ROOT_DROP_TARGET = "__root__";
const BACK_DROP_TARGET = "__back__";

type DropTargetId = string | typeof ROOT_DROP_TARGET | typeof BACK_DROP_TARGET;

function hasAssetDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("application/x-asset-id");
}

function hasFileDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

function getDraggedFiles(dataTransfer: DataTransfer): File[] {
  return Array.from(dataTransfer.files ?? []);
}

// ─── Main Component ─────────────────────────────────────────────────

export function LibraryAssetsTab({
  highlightedAssetId,
  showBindingHint = false,
}: {
  highlightedAssetId?: string;
  /** Show the "bind a folder to a card" hint banner (global library only). */
  showBindingHint?: boolean;
}) {
  const { t } = useTranslation("library");
  const { requireAuth, isAuthenticated, session } = useAuthGuard();
  const assets = useUserAssetStore(s => s.assets);
  const folders = useUserAssetStore(s => s.folders);
  const storage = useUserAssetStore(s => s.storage);
  const loading = useUserAssetStore(s => s.loading);
  const uploading = useUserAssetStore(s => s.uploading);
  const uploadingCount = useUserAssetStore(s => s.uploadingCount);
  const fetchAssets = useUserAssetStore(s => s.fetchAssets);
  const fetchAssetById = useUserAssetStore(s => s.fetchAssetById);
  const fetchFolders = useUserAssetStore(s => s.fetchFolders);
  const uploadAsset = useUserAssetStore(s => s.uploadAsset);
  const deleteAsset = useUserAssetStore(s => s.deleteAsset);
  const renameAsset = useUserAssetStore(s => s.renameAsset);
  const moveAsset = useUserAssetStore(s => s.moveAsset);
  const createFolder = useUserAssetStore(s => s.createFolder);
  const renameFolder = useUserAssetStore(s => s.renameFolder);
  const deleteFolder = useUserAssetStore(s => s.deleteFolder);
  const page = useUserAssetStore(s => s.page);
  const total = useUserAssetStore(s => s.total);
  const pageSize = useUserAssetStore(s => s.pageSize);

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  // Platform image generation is hosted-only; the local edition shows uploads only.
  const imageGeneration = useFeature("imageGeneration");
  const [generationOpen, setGenerationOpen] = useState(false);
  const [generationReferenceId, setGenerationReferenceId] = useState<string | undefined>();
  const [generationOwner, setGenerationOwner] = useState(session?.user.id);
  useEffect(() => {
    setGenerationOpen(false);
    setGenerationReferenceId(undefined);
    setGenerationOwner(session?.user.id);
    setCurrentFolderId(null);
  }, [session?.user.id]);
  const [assetFilter, setAssetFilter] = useState<
    "all" | "image" | "audio" | "font" | "txt" | "other"
  >("all");
  const [previewAsset, setPreviewAsset] = useState<UserAsset | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [moveDragOverId, setMoveDragOverId] = useState<string | null>(null);
  const [fileDragOverId, setFileDragOverId] = useState<DropTargetId | null>(null);
  const [pendingUploadCount, setPendingUploadCount] = useState(0);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
  const [bindTargetFolder, setBindTargetFolder] = useState<AssetFolder | null>(null);
  const [hintDismissed, setHintDismissed] = useState(
    () =>
      typeof localStorage !== "undefined" &&
      localStorage.getItem("yumina.folderBindingHint") === "dismissed"
  );
  const [textPreview, setTextPreview] = useState("");
  const [textPreviewLoading, setTextPreviewLoading] = useState(false);
  const [textPreviewError, setTextPreviewError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchCurrentPage = useCallback(
    (p?: number) => {
      const opts: { type?: string; folderId?: string; page?: number } = {};
      if (assetFilter !== "all") opts.type = assetFilter;
      if (currentFolderId) opts.folderId = currentFolderId;
      else opts.folderId = "root";
      if (p !== undefined) opts.page = p;
      fetchAssets(opts);
    },
    [fetchAssets, assetFilter, currentFolderId]
  );

  useEffect(() => {
    fetchCurrentPage(1);
    fetchFolders();
  }, [fetchCurrentPage, fetchFolders]);

  useEffect(() => {
    if (!highlightedAssetId) return;

    let cancelled = false;

    void (async () => {
      const asset = await fetchAssetById(highlightedAssetId);
      if (!asset || cancelled) return;

      setCurrentFolderId(asset.folderId);
      setPreviewAsset(asset);
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchAssetById, highlightedAssetId]);

  // ─── Derived data ───────────────────────────────────────────────

  // Breadcrumb path from root → current folder
  const breadcrumb = useMemo(() => {
    const path: AssetFolder[] = [];
    let id = currentFolderId;
    while (id) {
      const folder = folders.find((f) => f.id === id);
      if (!folder) break;
      path.unshift(folder);
      id = folder.parentFolderId;
    }
    return path;
  }, [currentFolderId, folders]);

  // Child folders of current location
  const childFolders = useMemo(
    () =>
      folders
        .filter((f) => f.parentFolderId === currentFolderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders, currentFolderId]
  );

  // Assets are already filtered server-side by folderId and type
  const childAssets = assets;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Asset counts come from server via folder.assetCount

  // Storage
  const usedMB = (storage.used / (1024 * 1024)).toFixed(1);
  const limitGB = (storage.limit / (1024 * 1024 * 1024)).toFixed(1);
  const usagePercent =
    storage.limit > 0 ? (storage.used / storage.limit) * 100 : 0;
  const currentFolder = useMemo(
    () => folders.find((folder) => folder.id === currentFolderId) ?? null,
    [folders, currentFolderId]
  );
  const parentFolderId = currentFolder?.parentFolderId ?? null;
  const effectiveUploadCount = pendingUploadCount > 0 ? pendingUploadCount : uploadingCount;
  const assetFilterLabels: Record<"all" | "image" | "audio" | "font" | "txt" | "other", string> = {
    all: t("assets.all"),
    image: t("assets.image"),
    audio: t("assets.audio"),
    font: t("assets.font"),
    txt: t("assets.txt"),
    other: t("assets.other"),
  };

  const fileDropTargetLabel = useMemo(() => {
    if (!fileDragOverId) return t("assets.allAssets");
    if (fileDragOverId === ROOT_DROP_TARGET) return t("assets.allAssets");
    if (fileDragOverId === BACK_DROP_TARGET) {
      return folders.find((folder) => folder.id === parentFolderId)?.name ?? t("assets.parentFolder");
    }

    return folders.find((folder) => folder.id === fileDragOverId)?.name ?? currentFolder?.name ?? t("assets.currentFolder");
  }, [currentFolder?.name, fileDragOverId, folders, parentFolderId, t]);
  const gridDropTargetId: DropTargetId = currentFolderId ?? ROOT_DROP_TARGET;

  // ─── Handlers ───────────────────────────────────────────────────

  const uploadFiles = useCallback(
    async (files: File[], folderId: string | null) => {
      if (files.length === 0) return;

      setPendingUploadCount(files.length);

      try {
        for (const [index, file] of files.entries()) {
          const { type } = getUploadMetadata(file);
          await uploadAsset(file, type, folderId ?? undefined);
          setPendingUploadCount(files.length - index - 1);
        }
      } finally {
        setPendingUploadCount(0);
        fetchCurrentPage();
      }
    },
    [fetchCurrentPage, uploadAsset]
  );

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      await uploadFiles(files, currentFolderId);
    },
    [currentFolderId, uploadFiles]
  );

  const handleCreateFolder = useCallback(async () => {
    const folder = await createFolder(t("assets.newFolder"), currentFolderId ?? undefined);
    if (folder) setRenamingFolderId(folder.id);
  }, [createFolder, currentFolderId, t]);

  const handleDeleteFolder = useCallback(
    (id: string) => {
      deleteFolder(id);
      if (currentFolderId === id) setCurrentFolderId(null);
    },
    [deleteFolder, currentFolderId]
  );

  const resolveFolderIdForDropTarget = useCallback(
    (targetId: DropTargetId): string | null => {
      if (targetId === ROOT_DROP_TARGET) return null;
      if (targetId === BACK_DROP_TARGET) return parentFolderId;
      return targetId;
    },
    [parentFolderId]
  );

  // Drag and drop
  const handleDragStart = useCallback(
    (e: React.DragEvent, assetId: string) => {
      e.dataTransfer.setData("application/x-asset-id", assetId);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  const handleTargetDragOver = useCallback(
    (e: React.DragEvent, targetId: DropTargetId) => {
      if (hasAssetDragPayload(e.dataTransfer)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setMoveDragOverId(targetId);
        return;
      }

      if (hasFileDragPayload(e.dataTransfer)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setFileDragOverId(targetId);
      }
    },
    []
  );

  const handleTargetDragLeave = useCallback((e: React.DragEvent, targetId: DropTargetId) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) {
      return;
    }

    if (hasAssetDragPayload(e.dataTransfer) && moveDragOverId === targetId) {
      e.stopPropagation();
      setMoveDragOverId(null);
    }

    if (hasFileDragPayload(e.dataTransfer) && fileDragOverId === targetId) {
      e.stopPropagation();
      setFileDragOverId(null);
    }
  }, [fileDragOverId, moveDragOverId]);

  const handleTargetDrop = useCallback(
    async (e: React.DragEvent, targetId: DropTargetId) => {
      e.preventDefault();
      e.stopPropagation();
      setMoveDragOverId(null);
      setFileDragOverId(null);

      const assetId = e.dataTransfer.getData("application/x-asset-id");
      const folderId = resolveFolderIdForDropTarget(targetId);

      if (assetId) {
        moveAsset(assetId, folderId);
        return;
      }

      const files = getDraggedFiles(e.dataTransfer);
      if (files.length > 0) {
        await uploadFiles(files, folderId);
      }
    },
    [moveAsset, resolveFolderIdForDropTarget, uploadFiles]
  );

  const toggleSelectAsset = useCallback((id: string, next: boolean) => {
    setSelectedAssetIds((prev) => {
      const s = new Set(prev);
      if (next) s.add(id);
      else s.delete(id);
      return s;
    });
  }, []);

  const exitBulkMode = useCallback(() => {
    setBulkMode(false);
    setSelectedAssetIds(new Set());
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (selectedAssetIds.size === 0) return;
    setBulkDeleting(true);
    const ids = Array.from(selectedAssetIds);
    const results = await Promise.allSettled(ids.map((id) => deleteAsset(id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    const success = ids.length - failed;
    // T0 on a clean sweep — the tiles are gone. Speak only when some survived.
    if (failed > 0) {
      feedback.error(
        success === 0
          ? t("bulk.deletedFailed")
          : t("bulk.deletedPartial", { success, total: ids.length, failed }),
      );
    }
    setBulkDeleting(false);
    setConfirmBulkDelete(false);
    setBulkMode(false);
    setSelectedAssetIds(new Set());
  }, [deleteAsset, selectedAssetIds, t]);

  // R2: in the preview dialog the button's icon becomes a check, so nothing is
  // announced. From an asset card's context menu the menu closes and NOTHING on
  // screen changes — that path (announce = true) gets the plain notice pill.
  const { copied: refCopied, copy: writeRef } = useCopyFeedback();
  const { copied: urlCopied, copy: writeUrl } = useCopyFeedback();

  const copyRef = useCallback(async (id: string, announce = false) => {
    if (!(await writeRef(`@asset:${id}`))) {
      feedback.error(t("assets.copyFailed", "Couldn't copy to the clipboard"));
      return;
    }
    if (announce) feedback.notice(t("assets.copiedRef"));
  }, [writeRef, t]);

  const copyUrl = useCallback(async (id: string, announce = false) => {
    if (!(await writeUrl(getAssetCdnUrl(id)))) {
      feedback.error(t("assets.copyFailed", "Couldn't copy to the clipboard"));
      return;
    }
    if (announce) feedback.notice(t("assets.copiedUrl"));
  }, [writeUrl, t]);

  // Force a browser download with the original filename. Cross-origin <a download>
  // is ignored by browsers, so fetch the blob and trigger the download locally.
  const downloadAsset = useCallback(async (asset: UserAsset) => {
    try {
      const res = await fetch(asset.url);
      if (!res.ok) throw new Error("Failed to download");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = asset.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch {
      // R7: the browser's download shelf covers the good case; only the miss
      // needs a pill.
      feedback.error(t("toast.failedToDownload"));
    }
  }, [t]);

  // Font preview
  const fontFaceStyle = useMemo(() => {
    if (!previewAsset || previewAsset.type !== "font") return null;
    const fontFamily = `preview-${previewAsset.id}`;
    return (
      <style>{`@font-face { font-family: '${fontFamily}'; src: url('${previewAsset.url}'); }`}</style>
    );
  }, [previewAsset]);

  useEffect(() => {
    if (!isTextAsset(previewAsset)) {
      setTextPreview("");
      setTextPreviewLoading(false);
      setTextPreviewError(null);
      return;
    }

    let cancelled = false;

    setTextPreview("");
    setTextPreviewError(null);
    setTextPreviewLoading(true);

    // Intentionally no credentials — /cdn/* is public and responds with
    // Access-Control-Allow-Origin: *, which browsers reject when paired with
    // credentialed requests ("Failed to fetch" in dev across the 5180 ↔ 3000
    // split).
    fetch(previewAsset.url)
      .then(async (res) => {
        if (!res.ok) throw new Error(t("assets.previewLoadFailed"));
        return res.text();
      })
      .then((content) => {
        if (cancelled) return;
        setTextPreview(content);
      })
      .catch((error) => {
        if (cancelled) return;
        setTextPreviewError(error instanceof Error ? error.message : t("assets.previewLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setTextPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [previewAsset, t]);

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <div className="library-section-stack mb-10">
      {/* ─── Folder-binding hint ─── */}
      {showBindingHint && !hintDismissed && (
        <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
          <Link2 size={16} className="mt-0.5 shrink-0 text-primary" />
          <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
            {t("bindings.hint")}
          </p>
          <button
            onClick={() => {
              setHintDismissed(true);
              try {
                localStorage.setItem("yumina.folderBindingHint", "dismissed");
              } catch {
                /* ignore */
              }
            }}
            title={t("bindings.dismissHint")}
            className="shrink-0 rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-white/5 hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ─── Storage Header ─── */}
      <div className="library-overview-surface flex flex-col justify-between gap-6 rounded-xl p-6 md:flex-row md:items-center">
        <div>
          <h2 className="text-xl font-bold text-foreground mb-1 flex items-center gap-2">
            <FileText className="text-primary" size={20} />
            {t("assets.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("assets.description")}
          </p>
        </div>
        <div className="library-overview-surface library-overview-surface--inset w-full max-w-xs flex-1 rounded-lg p-3">
          <div className="flex justify-between items-end mb-1.5">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
              {t("assets.storage")}
            </span>
            <span className="text-xs font-bold text-foreground">
              {usedMB} MB
              <span className="text-muted-foreground font-normal">
                {" "}
                / {limitGB} GB
              </span>
            </span>
          </div>
          <div className="w-full h-1.5 bg-black/50 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full"
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* ─── Toolbar ─── */}
      <div className="library-asset-toolbar">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-sm min-w-0 flex-1">
          <button
            onClick={() => setCurrentFolderId(null)}
            className={`shrink-0 px-2 py-1 rounded-md transition-colors ${
              currentFolderId === null
                ? "text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-white/5"
            }`}
          >
            {t("assets.allAssets")}
          </button>
          {breadcrumb.map((folder) => (
            <div key={folder.id} className="flex items-center gap-1 min-w-0">
              <ChevronRight
                size={14}
                className="shrink-0 text-muted-foreground/30"
              />
              <button
                onClick={() => setCurrentFolderId(folder.id)}
                className={`truncate px-2 py-1 rounded-md transition-colors ${
                  currentFolderId === folder.id
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                {folder.name}
              </button>
            </div>
          ))}
        </nav>

        {/* Type filters */}
        <div className="library-asset-filters">
          {(["all", "image", "audio", "font", "txt", "other"] as const).map(
            (type) => (
              <button
                key={type}
                onClick={() => setAssetFilter(type)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                  assetFilter === type
                    ? "bg-primary/20 text-primary border border-primary/50"
                    : "text-muted-foreground/60 border border-transparent hover:text-foreground"
                }`}
              >
                {assetFilterLabels[type]}
              </button>
            )
          )}
        </div>

        {/* Actions */}
        <BulkActionsBar
          active={bulkMode}
          selectedCount={selectedAssetIds.size}
          totalCount={childAssets.length}
          onToggle={() => (bulkMode ? exitBulkMode() : setBulkMode(true))}
          onSelectAll={() => setSelectedAssetIds(new Set(childAssets.map((a) => a.id)))}
          onClear={() => setSelectedAssetIds(new Set())}
          onDelete={() => setConfirmBulkDelete(true)}
        />
        {!bulkMode && <>
          {imageGeneration && (
            <button
              onClick={() => { if (!isAuthenticated) { requireAuth("create worlds"); return; } setGenerationOpen(true); }}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              <ImagePlus size={14} />
              {t("generation.openButton")}
            </button>
          )}
          <button
            onClick={() => { if (!isAuthenticated) { requireAuth("create worlds"); return; } handleCreateFolder(); }}
            title={t("assets.newFolder")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground border border-border hover:bg-white/5 hover:text-foreground transition-colors"
          >
            <FolderPlus size={14} />
            {t("assets.newFolder")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleUpload}
          />
          <button
            onClick={() => { if (!isAuthenticated) { requireAuth("create worlds"); return; } fileInputRef.current?.click(); }}
            disabled={uploading}
            className="flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-bold px-4 py-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
            {uploading
              ? effectiveUploadCount > 1
                ? t("assets.uploadingCount", { count: effectiveUploadCount })
                : t("assets.uploading")
              : t("assets.upload")}
          </button>
        </>}
      </div>

      {/* ─── File Grid ─── */}
      <div
        className="relative"
        onDragOver={(e) => handleTargetDragOver(e, gridDropTargetId)}
        onDragLeave={(e) => handleTargetDragLeave(e, gridDropTargetId)}
        onDrop={(e) => void handleTargetDrop(e, gridDropTargetId)}
      >
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : !currentFolderId && childFolders.length === 0 && childAssets.length === 0 ? (
          <div className="relative overflow-hidden rounded-2xl border border-dashed border-white/10">
            <LibraryEmptyState
              icon={<HardDrive size={36} />}
              headline={t("assets.emptyHeadline")}
              subtitle={t("assets.emptySubtitle")}
              ctaLabel={t("assets.emptyCta")}
              onCta={() => fileInputRef.current?.click()}
            />
          </div>
        ) : (
          <div className="library-asset-grid">
            {/* Back card — when inside a folder */}
            {currentFolderId && (
              <button
                onClick={() => setCurrentFolderId(parentFolderId)}
                onDragOver={(e) => handleTargetDragOver(e, BACK_DROP_TARGET)}
                onDragLeave={(e) => handleTargetDragLeave(e, BACK_DROP_TARGET)}
                onDrop={(e) => void handleTargetDrop(e, BACK_DROP_TARGET)}
                className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 transition-colors ${
                  moveDragOverId === BACK_DROP_TARGET || fileDragOverId === BACK_DROP_TARGET
                    ? "border-primary bg-primary/10"
                    : "border-white/10 hover:border-white/20 hover:bg-white/[0.02]"
                }`}
              >
                <Folder size={32} className="text-muted-foreground/30 mb-2" />
                <span className="text-xs text-muted-foreground">..</span>
              </button>
            )}

            {/* ─── Folder Cards ─── */}
            {childFolders.map((folder) => (
              <FolderCard
                key={folder.id}
                folder={folder}
                assetCount={folder.assetCount}
                boundCount={folder.boundWorlds?.length ?? 0}
                isDragOver={moveDragOverId === folder.id || fileDragOverId === folder.id}
                isRenaming={renamingFolderId === folder.id}
                onOpen={() => setCurrentFolderId(folder.id)}
                onRename={(name) => renameFolder(folder.id, name)}
                onDelete={() => handleDeleteFolder(folder.id)}
                onStartRename={() => setRenamingFolderId(folder.id)}
                onCancelRename={() => setRenamingFolderId(null)}
                onBindToCard={() => setBindTargetFolder(folder)}
                onDragOver={(e) => handleTargetDragOver(e, folder.id)}
                onDragLeave={(e) => handleTargetDragLeave(e, folder.id)}
                onDrop={(e) => void handleTargetDrop(e, folder.id)}
              />
            ))}

            {/* ─── Asset Cards ─── */}
            {childAssets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                isConfirmingDelete={confirmDeleteId === asset.id}
                isRenaming={renamingAssetId === asset.id}
                folders={folders}
                onPreview={() => setPreviewAsset(asset)}
                onCopyRef={() => void copyRef(asset.id, true)}
                onCopyUrl={() => void copyUrl(asset.id, true)}
                onRename={(name) => renameAsset(asset.id, name)}
                onStartRename={() => setRenamingAssetId(asset.id)}
                onCancelRename={() => setRenamingAssetId(null)}
                onDelete={() => deleteAsset(asset.id)}
                onConfirmDelete={() => setConfirmDeleteId(asset.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onMove={(folderId) => moveAsset(asset.id, folderId)}
                onDragStart={(e) => handleDragStart(e, asset.id)}
                selectable={bulkMode}
                selected={selectedAssetIds.has(asset.id)}
                onSelectChange={(s) => toggleSelectAsset(asset.id, s)}
              />
            ))}
          </div>
        )}

        {fileDragOverId && !loading && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-black/70 px-6 backdrop-blur-sm">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <div className="rounded-full border border-primary/40 bg-primary/15 p-4 text-primary">
                <Upload size={28} />
              </div>
              <div>
                <p className="text-sm font-bold text-foreground">
                  {t("assets.dropToUpload")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("assets.dropTarget", { target: fileDropTargetLabel })}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── Pagination ─── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            disabled={page <= 1}
            onClick={() => fetchCurrentPage(page - 1)}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
          >
            <ChevronLeft size={14} />
            {t("assets.prev")}
          </button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => fetchCurrentPage(page + 1)}
            className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
          >
            {t("assets.next")}
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {imageGeneration && (
        <GenerationPanel
          key={session?.user.id ?? "guest"}
          open={generationOpen && generationOwner === session?.user.id}
          onOpenChange={(open) => {
            setGenerationOpen(open);
            if (!open) { setGenerationReferenceId(undefined); void fetchCurrentPage(); void fetchFolders(); }
          }}
          defaultFolderId={currentFolderId}
          initialReferenceAssetId={generationReferenceId}
          onGenerated={() => { void fetchCurrentPage(); void fetchFolders(); }}
        />
      )}
      {/* ─── Preview Dialog ─── */}
      <Dialog
        open={!!previewAsset}
        onOpenChange={(open) => !open && setPreviewAsset(null)}
      >
        {previewAsset?.type === "image" ? (
          <DialogContent className="bg-transparent border-none p-0 shadow-none max-w-[90vw] gap-2 [&>button]:text-white/70 [&>button]:hover:text-white [&>button]:hover:bg-white/10 [&>button]:rounded-full [&>button]:-top-2 [&>button]:-right-2 [&>button]:h-8 [&>button]:w-8 [&>button]:flex [&>button]:items-center [&>button]:justify-center">
            <DialogTitle className="sr-only">
              {previewAsset.filename}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("assets.imagePreview")}
            </DialogDescription>
            <img
              src={previewAsset.url}
              alt={previewAsset.filename}
              className="max-h-[85vh] max-w-full object-contain rounded-lg mx-auto"
            />
            <div className="flex items-center gap-2 px-1">
              <span className="text-sm text-foreground/60 truncate flex-1">
                {previewAsset.filename}
              </span>
              {imageGeneration && (
                <button
                  onClick={() => { setGenerationReferenceId(previewAsset.id); setPreviewAsset(null); setGenerationOpen(true); }}
                  className="flex shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs text-foreground/70 transition-colors hover:bg-white/20 hover:text-foreground"
                >
                  <ImagePlus size={12} />
                  {t("generation.makeImage")}
                </button>
              )}
              <button
                onClick={() => void copyRef(previewAsset.id)}
                className="flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs text-foreground/70 hover:bg-white/20 hover:text-foreground transition-colors shrink-0"
              >
                {refCopied ? <Check size={12} /> : <Copy size={12} />}
                {t("assets.copyRef")}
              </button>
              <button
                onClick={() => void copyUrl(previewAsset.id)}
                className="flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs text-foreground/70 hover:bg-white/20 hover:text-foreground transition-colors shrink-0"
              >
                {urlCopied ? <Check size={12} /> : <Link size={12} />}
                {t("assets.copyUrl")}
              </button>
              <button
                onClick={() => downloadAsset(previewAsset)}
                className="flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs text-foreground/70 hover:bg-white/20 hover:text-foreground transition-colors shrink-0"
              >
                <Download size={12} />
                {t("assets.download")}
              </button>
            </div>
          </DialogContent>
        ) : (
          <DialogContent className="max-w-md bg-card border-border shadow-2xl [&>button]:text-muted-foreground [&>button]:hover:text-foreground [&>button]:hover:bg-white/10 [&>button]:rounded-full">
            <DialogHeader>
              <DialogTitle className="text-base text-foreground truncate pr-8">
                {previewAsset?.filename}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                {previewAsset?.mimeType ?? previewAsset?.type} ·{" "}
                {previewAsset && formatSize(previewAsset.sizeBytes)}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-2 -mt-1">
              <button
                onClick={() => void copyRef(previewAsset!.id)}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {refCopied ? <Check size={12} /> : <Copy size={12} />}
                {t("assets.copyRef")}
              </button>
              <button
                onClick={() => void copyUrl(previewAsset!.id)}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {urlCopied ? <Check size={12} /> : <Link size={12} />}
                {t("assets.copyUrl")}
              </button>
              <button
                onClick={() => downloadAsset(previewAsset!)}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <Download size={12} />
                {t("assets.download")}
              </button>
            </div>

            <div className="flex items-center justify-center py-4">
              {previewAsset?.type === "audio" && (
                <audio
                  controls
                  autoPlay
                  src={previewAsset.url}
                  className="w-full"
                />
              )}
              {previewAsset?.type === "font" && (
                <div className="w-full text-center space-y-4">
                  {fontFaceStyle}
                  <p
                    className="text-2xl text-foreground"
                    style={{
                      fontFamily: `'preview-${previewAsset.id}'`,
                    }}
                  >
                    {t("assets.fontPreview")}
                  </p>
                  <p
                    className="text-lg text-muted-foreground"
                    style={{
                      fontFamily: `'preview-${previewAsset.id}'`,
                    }}
                  >
                    ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789
                  </p>
                </div>
              )}
              {isTextAsset(previewAsset) && (
                <div className="w-full rounded-xl border border-white/10 bg-black/20 p-3">
                  {textPreviewLoading ? (
                    <p className="text-sm text-muted-foreground">
                      {t("assets.loadingPreview")}
                    </p>
                  ) : textPreviewError ? (
                    <p className="text-sm text-destructive">
                      {textPreviewError}
                    </p>
                  ) : (
                    <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words text-left text-xs leading-6 text-foreground">
                      {textPreview}
                    </pre>
                  )}
                </div>
              )}
              {previewAsset?.type === "other" && !isTextAsset(previewAsset) && (
                <div className="text-center space-y-2 py-4">
                  <FileIcon
                    size={40}
                    className="mx-auto text-muted-foreground/50"
                  />
                  <p className="text-muted-foreground text-sm">
                    {t("assets.previewNotAvailable")}
                  </p>
                </div>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>

      {/* Bulk delete confirmation */}
      <Dialog
        open={confirmBulkDelete}
        onOpenChange={(open) => { if (!open && !bulkDeleting) setConfirmBulkDelete(false); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 size={18} className="text-red-400" />
              {t("bulk.deleteTitle", { count: selectedAssetIds.size })}
            </DialogTitle>
            <DialogDescription dangerouslySetInnerHTML={{ __html: t("bulk.deleteConfirmAssets", { count: selectedAssetIds.size }) }} />
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
              disabled={bulkDeleting || selectedAssetIds.size === 0}
              className="px-4 py-2 text-sm bg-red-600 text-white font-medium rounded hover:bg-red-700 transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {bulkDeleting && <Loader2 size={14} className="animate-spin" />}
              {bulkDeleting ? t("bulk.deleting") : t("bulk.delete")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bind folder → card picker */}
      <BindToCardDialog
        folder={bindTargetFolder}
        onClose={() => setBindTargetFolder(null)}
      />
    </div>
  );
}

// ─── Bind-to-card Dialog ────────────────────────────────────────────

function BindToCardDialog({
  folder,
  onClose,
}: {
  folder: AssetFolder | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("library");
  const worlds = useWorldsStore((s) => s.worlds);
  const fetchWorlds = useWorldsStore((s) => s.fetchWorlds);
  const bind = useFolderBindingStore((s) => s.bind);
  const unbind = useFolderBindingStore((s) => s.unbind);
  const { data: session } = useSession();
  const userId = session?.user?.id ?? "";
  // Track the live folder from the store so bound-state updates as the user
  // binds/unbinds without reopening the dialog (the `folder` prop is a snapshot).
  const liveFolder = useUserAssetStore((s) =>
    folder ? s.folders.find((f) => f.id === folder.id) ?? folder : null,
  );

  useEffect(() => {
    if (folder) void fetchWorlds();
  }, [folder, fetchWorlds]);

  // Only cards the user actually created can be bound to — the worlds list also
  // carries library copies owned by other creators, which the server rejects.
  const ownWorlds = worlds.filter((w) => w.creatorId === userId);
  const boundIds = new Set((liveFolder?.boundWorlds ?? []).map((b) => b.worldId));

  return (
    <Dialog open={!!folder} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("bindings.bindToCardTitle", { folder: folder?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>{t("bindings.bindToCardDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto py-1">
          {ownWorlds.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground/50">
              {t("bindings.noCards")}
            </p>
          ) : (
            ownWorlds.map((w) => {
              const isBound = boundIds.has(w.id);
              return (
                <button
                  key={w.id}
                  onClick={async () => {
                    if (!folder) return;
                    const card = w.name || t("detail.draft");
                    // R1: the row's border, tint and "Bound" check flip in
                    // place; the store's own pill covers a failure.
                    if (isBound) await unbind(w.id, folder.id);
                    else await bind(w.id, folder.id, card);
                  }}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    isBound
                      ? "border-primary/40 bg-primary/5"
                      : "border-border hover:border-primary/40 hover:bg-white/5"
                  }`}
                >
                  {w.thumbnailUrl ? (
                    <img
                      src={w.thumbnailUrl}
                      alt=""
                      className="h-8 w-8 shrink-0 rounded object-cover ring-1 ring-white/10"
                    />
                  ) : (
                    <div className="h-8 w-8 shrink-0 rounded bg-white/5" />
                  )}
                  <span className="flex-1 truncate text-foreground">
                    {w.name || t("detail.draft")}
                  </span>
                  {isBound && (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary">
                      <CheckIcon size={13} />
                      {t("bindings.bound")}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Folder Card ────────────────────────────────────────────────────

function FolderCard({
  folder,
  assetCount,
  boundCount,
  isDragOver,
  isRenaming,
  onOpen,
  onRename,
  onDelete,
  onStartRename,
  onCancelRename,
  onBindToCard,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  folder: AssetFolder;
  assetCount: number;
  boundCount: number;
  isDragOver: boolean;
  isRenaming: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onBindToCard: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { t } = useTranslation("library");
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      requestAnimationFrame(() => renameRef.current?.select());
    }
  }, [isRenaming]);

  function submitRename() {
    const trimmed = renameRef.current?.value.trim() ?? "";
    if (trimmed && trimmed !== folder.name) onRename(trimmed);
    onCancelRename();
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`library-overview-surface library-overview-surface--interactive group relative flex flex-col items-center rounded-xl p-5 text-center transition-all cursor-pointer ${
            isDragOver
              ? "library-overview-surface--dragover scale-[1.02]"
              : "hover:border-white/20"
          }`}
          onClick={() => {
            if (!isRenaming) onOpen();
          }}
        >
          <div className="library-overview-surface library-overview-surface--inset mb-3 flex h-28 w-full items-center justify-center rounded-lg">
            {isDragOver ? (
              <FolderOpen
                size={54}
                className="text-primary transition-colors"
              />
            ) : (
              <Folder
                size={54}
                className="text-muted-foreground/35 transition-colors group-hover:text-primary/50"
              />
            )}
          </div>

          {isRenaming ? (
            <input
              ref={renameRef}
              defaultValue={folder.name}
              onBlur={submitRename}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") onCancelRename();
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-white/10 border border-white/20 rounded px-2 py-0.5 text-xs text-center text-foreground outline-none focus:border-primary/50"
            />
          ) : (
            <span className="text-xs font-medium text-foreground truncate w-full">
              {folder.name}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/40 mt-0.5">
            {t("assets.items", { count: assetCount })}
          </span>

          {/* Bound-card badge */}
          {boundCount > 0 && (
            <span
              className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold text-primary"
              title={(folder.boundWorlds ?? []).map((b) => b.worldName).join(", ")}
            >
              <Link2 size={9} />
              {t("bindings.boundCount", { count: boundCount })}
            </span>
          )}

          {/* Hover overlay — bind, rename & delete */}
          {!isRenaming && (
            <div className="library-asset-overlay-actions touch-reveal absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onBindToCard();
                }}
                title={t("bindings.bindToCard")}
                className="library-asset-overlay-button rounded-md bg-black/60 p-1 text-white/70 backdrop-blur-sm transition-colors hover:text-primary"
              >
                <Link2 size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStartRename();
                }}
                title={t("assets.rename")}
                className="library-asset-overlay-button rounded-md bg-black/60 p-1 text-white/70 backdrop-blur-sm transition-colors hover:text-white"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                title={t("assets.deleteFolder")}
                className="library-asset-overlay-button rounded-md bg-black/60 p-1 text-white/70 backdrop-blur-sm transition-colors hover:text-destructive"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onOpen}>
          <FolderOpen size={14} />
          {t("assets.open")}
        </ContextMenuItem>
        <ContextMenuItem onClick={onStartRename}>
          <Pencil size={14} />
          {t("assets.rename")}
        </ContextMenuItem>
        <ContextMenuItem onClick={onBindToCard}>
          <Link2 size={14} />
          {t("bindings.bindToCard")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 size={14} />
          {t("assets.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Asset Card ─────────────────────────────────────────────────────

function AssetCard({
  asset,
  isConfirmingDelete,
  isRenaming,
  folders,
  onPreview,
  onCopyRef,
  onCopyUrl,
  onRename,
  onStartRename,
  onCancelRename,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  onMove,
  onDragStart,
  selectable,
  selected,
  onSelectChange,
}: {
  asset: UserAsset;
  isConfirmingDelete: boolean;
  isRenaming: boolean;
  folders: AssetFolder[];
  onPreview: () => void;
  onCopyRef: () => void;
  onCopyUrl: () => void;
  onRename: (name: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onMove: (folderId: string | null) => void;
  onDragStart: (e: React.DragEvent) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelectChange?: (selected: boolean) => void;
}) {
  const { t } = useTranslation("library");
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      requestAnimationFrame(() => renameRef.current?.select());
    }
  }, [isRenaming]);

  function submitRename() {
    const trimmed = renameRef.current?.value.trim() ?? "";
    if (trimmed && trimmed !== asset.filename) onRename(trimmed);
    onCancelRename();
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          draggable={!selectable}
          onDragStart={onDragStart}
          onClick={selectable ? (e) => { e.stopPropagation(); onSelectChange?.(!selected); } : undefined}
          className={`library-overview-surface library-overview-surface--interactive group relative flex flex-col overflow-hidden rounded-xl transition-all duration-200 ${
            !selectable ? "hover:border-white/20" : ""
          } ${
            selectable
              ? selected
                ? "cursor-pointer scale-[0.97] ring-2 ring-primary ring-offset-2 ring-offset-background shadow-[0_8px_25px_rgba(232,184,49,0.25)]"
                : "cursor-pointer opacity-75 hover:opacity-100"
              : ""
          }`}
        >
          {selectable && selected && (
            <>
              <div className="pointer-events-none absolute inset-0 z-20 bg-primary/10" />
              <div className="absolute top-1.5 right-1.5 z-30 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_2px_8px_rgba(0,0,0,0.4)]">
                <Check size={11} strokeWidth={3} />
              </div>
            </>
          )}
          {/* Thumbnail / Icon area — click to preview */}
          <button
            onClick={selectable ? (e) => { e.stopPropagation(); onSelectChange?.(!selected); } : onPreview}
            className="library-overview-surface library-overview-surface--inset flex h-28 items-center justify-center cursor-pointer"
          >
            {asset.type === "image" ? (
              <img
                // A 176x112 tile pulled the full master: one folder of 66 images
                // was 143.7MB over the wire. Same edge-resize the hub cards have
                // used since June — that folder is 1.29MB now.
                src={cardImageUrl(asset.url, 400)}
                alt={asset.filename}
                className="h-full w-full object-cover"
                loading="lazy"
                onError={fallbackToOriginalOnError}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground/30">
                <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-[#E0C27A]">
                  {getAssetIcon(asset.type, 30)}
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/35">
                  {asset.type}
                </span>
              </div>
            )}
          </button>

          {/* Info + Copy Actions */}
          <div className="p-2.5">
            {isRenaming ? (
              <input
                ref={renameRef}
                defaultValue={asset.filename}
                onBlur={submitRename}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") submitRename();
                  if (e.key === "Escape") onCancelRename();
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-primary/50 mb-0.5"
              />
            ) : (
              <p
                className="mb-0.5 whitespace-normal break-words text-xs font-medium leading-snug text-foreground cursor-text"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onStartRename();
                }}
                title={`${asset.filename} - ${t("assets.doubleClickRename")}`}
              >
                {asset.filename}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground/50 mb-2">
              {asset.type} · {formatSize(asset.sizeBytes)}
            </p>

            {/* Primary actions — always visible */}
            <div className="flex gap-1.5">
              <button
                onClick={onCopyRef}
                title={t("assets.copyAssetRef")}
                className="flex-1 flex items-center justify-center gap-1 rounded-md bg-white/5 border border-white/10 py-1 text-[10px] font-medium text-muted-foreground hover:text-primary hover:border-primary/30 hover:bg-primary/5 transition-colors"
              >
                <Copy size={10} />
                {t("assets.ref")}
              </button>
              <button
                onClick={onCopyUrl}
                title={t("assets.copyPublicUrl")}
                className="flex-1 flex items-center justify-center gap-1 rounded-md bg-white/5 border border-white/10 py-1 text-[10px] font-medium text-muted-foreground hover:text-primary hover:border-primary/30 hover:bg-primary/5 transition-colors"
              >
                <Link size={10} />
                URL
              </button>
            </div>
          </div>

          {/* Hover overlay actions */}
          {!selectable && <div className="library-asset-overlay-actions touch-reveal absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={onStartRename}
              title={t("assets.rename")}
              className="library-asset-overlay-button rounded-md bg-black/60 p-1 text-white/70 backdrop-blur-sm transition-colors hover:text-white"
            >
              <Pencil size={12} />
            </button>
            <a
              href={asset.url}
              target="_blank"
              rel="noopener noreferrer"
              title={t("assets.download")}
              className="library-asset-overlay-button rounded-md bg-black/60 p-1 text-white/70 backdrop-blur-sm transition-colors hover:text-white"
            >
              <Download size={12} />
            </a>
            {isConfirmingDelete ? (
              <div className="flex gap-0.5">
                <button
                  onClick={() => {
                    onCancelDelete();
                    onDelete();
                  }}
                  className="px-1.5 py-0.5 rounded-md bg-destructive text-white text-[10px] font-bold"
                >
                  {t("assets.yes")}
                </button>
                <button
                  onClick={onCancelDelete}
                  className="px-1.5 py-0.5 rounded-md bg-black/60 text-white/70 text-[10px] backdrop-blur-sm"
                >
                  {t("assets.no")}
                </button>
              </div>
            ) : (
              <button
                onClick={onConfirmDelete}
                title={t("assets.delete")}
                className="library-asset-overlay-button rounded-md bg-black/60 p-1 text-white/70 backdrop-blur-sm transition-colors hover:text-destructive"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onCopyRef}>
          <Copy size={14} />
          {t("assets.copyAssetRef")}
        </ContextMenuItem>
        <ContextMenuItem onClick={onCopyUrl}>
          <Link size={14} />
          {t("assets.copyPublicUrl")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onStartRename}>
          <Pencil size={14} />
          {t("assets.rename")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Folder size={14} />
            {t("assets.moveTo")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onClick={() => onMove(null)}
              disabled={asset.folderId === null}
            >
              {t("assets.rootNoFolder")}
            </ContextMenuItem>
            {folders.length > 0 && <ContextMenuSeparator />}
            {folders.map((f) => (
              <ContextMenuItem
                key={f.id}
                onClick={() => onMove(f.id)}
                disabled={asset.folderId === f.id}
              >
                <Folder size={12} className="opacity-50" />
                {f.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem asChild>
          <a href={asset.url} target="_blank" rel="noopener noreferrer">
            <Download size={14} />
            {t("assets.download")}
          </a>
        </ContextMenuItem>
        <ContextMenuItem
          onClick={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 size={14} />
          {t("assets.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
