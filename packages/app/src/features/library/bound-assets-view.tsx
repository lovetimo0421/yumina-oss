import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useFeature } from "@/edition/edition";
import { GenerationPanel } from "@/edition/slots";
import {
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Music4,
  Type,
  FileText,
  File as FileIcon,
  Copy,
  Link2,
  Unlink,
  ChevronDown,
  ChevronRight,
  Loader2,
  Check,
  Upload,
  Trash2,
  ListChecks,
  FolderInput,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useFolderBindingStore } from "@/stores/folder-bindings";
import { useUserAssetStore, type UserAsset } from "@/stores/user-assets";
import { getAssetCdnUrl, cardImageUrl, fallbackToOriginalOnError } from "@/lib/asset-url";
import { getUploadMetadata } from "@/lib/asset-upload";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const apiBase = import.meta.env.VITE_API_URL || "";

interface RefAsset {
  assetId: string;
  type: string;
  filename: string;
  url: string;
}

function assetIcon(type: string, size = 22) {
  switch (type) {
    case "image":
      return <ImageIcon size={size} />;
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

export function BoundAssetsView({ worldId }: { worldId: string }) {
  const { t } = useTranslation("library");
  const { data: session } = useSession();
  // Platform image generation is hosted-only; without it the view is bindings + uploads.
  const imageGeneration = useFeature("imageGeneration");
  const generationScope = `${session?.user.id ?? "guest"}:${worldId}`;

  const bindings = useFolderBindingStore((s) => s.bindings);
  const bindingWorldId = useFolderBindingStore((s) => s.worldId);
  const loading = useFolderBindingStore((s) => s.loading);
  const fetchBindings = useFolderBindingStore((s) => s.fetch);
  const bind = useFolderBindingStore((s) => s.bind);
  const unbind = useFolderBindingStore((s) => s.unbind);

  const folders = useUserAssetStore((s) => s.folders);
  const fetchFolders = useUserAssetStore((s) => s.fetchFolders);
  const uploadAsset = useUserAssetStore((s) => s.uploadAsset);
  const deleteAsset = useUserAssetStore((s) => s.deleteAsset);
  const moveAsset = useUserAssetStore((s) => s.moveAsset);

  const [refs, setRefs] = useState<RefAsset[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [folderAssets, setFolderAssets] = useState<Record<string, UserAsset[]>>({});
  const [loadingFolderId, setLoadingFolderId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [generationOpen, setGenerationOpen] = useState(false);
  const [generationOwner, setGenerationOwner] = useState(generationScope);
  useEffect(() => {
    setGenerationOpen(false);
    setGenerationOwner(generationScope);
    setExpandedId(null);
  }, [generationScope]);
  const [uploadingFolderId, setUploadingFolderId] = useState<string | null>(null);
  const [uploadRemaining, setUploadRemaining] = useState(0);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const [manageFolderId, setManageFolderId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showMovePicker, setShowMovePicker] = useState(false);

  const fetchRefs = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/asset-refs`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const { data } = await res.json();
      setRefs(data ?? []);
    } catch {
      /* silent */
    }
  }, [worldId]);

  useEffect(() => {
    void fetchBindings(worldId);
    void fetchFolders();
    void fetchRefs();
  }, [worldId, fetchBindings, fetchFolders, fetchRefs]);

  const loadFolderAssets = useCallback(
    async (folderId: string, force = false) => {
      if (!force && folderAssets[folderId]) return;
      setLoadingFolderId(folderId);
      try {
        const res = await fetch(
          `${apiBase}/api/user-assets?folderId=${folderId}&limit=500`,
          { credentials: "include" },
        );
        if (res.ok) {
          const { data } = await res.json();
          setFolderAssets((prev) => ({ ...prev, [folderId]: data ?? [] }));
        }
      } finally {
        setLoadingFolderId(null);
      }
    },
    [folderAssets],
  );

  const uploadToFolder = useCallback(
    async (folderId: string, files: File[]) => {
      if (files.length === 0 || uploadingFolderId) return;
      setUploadingFolderId(folderId);
      setUploadRemaining(files.length);
      try {
        for (const [index, file] of files.entries()) {
          const { type } = getUploadMetadata(file);
          await uploadAsset(file, type, folderId);
          setUploadRemaining(files.length - index - 1);
        }
      } finally {
        setUploadingFolderId(null);
        setUploadRemaining(0);
        setExpandedId(folderId);
        await Promise.all([
          loadFolderAssets(folderId, true),
          fetchBindings(worldId),
          fetchFolders(),
        ]);
      }
    },
    [uploadingFolderId, uploadAsset, loadFolderAssets, fetchBindings, fetchFolders, worldId],
  );

  const pickFilesForFolder = useCallback((folderId: string) => {
    uploadTargetRef.current = folderId;
    fileInputRef.current?.click();
  }, []);

  const toggleFolder = useCallback(
    (folderId: string) => {
      setExpandedId((prev) => (prev === folderId ? null : folderId));
      setManageFolderId(null);
      setSelectedIds(new Set());
      void loadFolderAssets(folderId);
    },
    [loadFolderAssets],
  );

  // Only ever fired from an asset's context menu: the menu closes and nothing
  // on screen changes, so this is the one copy that still needs a word — the
  // plain notice pill, not a success.
  const { copy: writeRef } = useCopyFeedback();
  const copyRef = useCallback(
    async (id: string) => {
      if (!(await writeRef(`@asset:${id}`))) {
        feedback.error(t("assets.copyFailed", "Couldn't copy to the clipboard"));
        return;
      }
      feedback.notice(t("assets.copiedRef"));
    },
    [writeRef, t],
  );

  const toggleManage = useCallback((folderId: string) => {
    setManageFolderId((prev) => (prev === folderId ? null : folderId));
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((assetId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }, []);

  /** Refresh a folder's grid + counts after delete/move mutations. */
  const refreshAfterMutation = useCallback(
    async (folderId: string, removedIds: string[], invalidateFolderId?: string | null) => {
      setFolderAssets((prev) => {
        const next = { ...prev };
        if (next[folderId]) {
          next[folderId] = next[folderId].filter((a) => !removedIds.includes(a.id));
        }
        // Target folder of a move: drop its cache so it refetches fresh on expand.
        if (invalidateFolderId && next[invalidateFolderId]) {
          delete next[invalidateFolderId];
        }
        return next;
      });
      await Promise.all([fetchBindings(worldId), fetchFolders()]);
    },
    [fetchBindings, fetchFolders, worldId],
  );

  const confirmDelete = useCallback(async () => {
    const folderId = manageFolderId ?? expandedId;
    if (pendingDeleteIds.length === 0 || !folderId) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(pendingDeleteIds.map((id) => deleteAsset(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      // T0 when everything went: the tiles are gone from the grid.
      if (failed > 0) {
        const success = pendingDeleteIds.length - failed;
        feedback.error(
          success === 0
            ? t("bulk.deletedFailed")
            : t("bulk.deletedPartial", { success, total: pendingDeleteIds.length, failed }),
        );
      }
      await refreshAfterMutation(folderId, pendingDeleteIds);
    } finally {
      setBulkBusy(false);
      setPendingDeleteIds([]);
      setSelectedIds(new Set());
    }
  }, [pendingDeleteIds, manageFolderId, expandedId, deleteAsset, refreshAfterMutation, t]);

  const moveSelected = useCallback(
    async (targetFolderId: string | null) => {
      const folderId = manageFolderId;
      if (!folderId || selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      setBulkBusy(true);
      try {
        await Promise.allSettled(ids.map((id) => moveAsset(id, targetFolderId)));
        await refreshAfterMutation(folderId, ids, targetFolderId);
      } finally {
        setBulkBusy(false);
        setShowMovePicker(false);
        setSelectedIds(new Set());
      }
    },
    [manageFolderId, selectedIds, moveAsset, refreshAfterMutation],
  );

  const boundIds = new Set(bindings.map((b) => b.id));
  const bindableFolders = folders.filter((f) => !boundIds.has(f.id));

  const hasNothing = !loading && bindings.length === 0 && refs.length === 0;

  return (
    <div className="library-section-stack mb-10">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-foreground">
            <Folder className="text-primary" size={20} />
            {t("bindings.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("bindings.description")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {imageGeneration && (
            <button onClick={() => setGenerationOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground">
              <ImagePlus size={14} />{t("generation.openButton")}
            </button>
          )}
          <button
            onClick={() => setShowPicker(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <FolderPlus size={14} />
            {t("bindings.bindFolder")}
          </button>
        </div>
      </div>

      {imageGeneration && (
        <GenerationPanel key={generationScope}
          open={generationOpen && generationOwner === generationScope && !!session?.user.id}
          onOpenChange={(open) => {
            setGenerationOpen(open);
            if (!open) { void fetchBindings(worldId); void fetchFolders(); if (expandedId) void loadFolderAssets(expandedId, true); }
          }}
          defaultFolderId={bindingWorldId === worldId && !loading ? (expandedId ?? bindings[0]?.id ?? null) : null}
          onGenerated={() => {
            void fetchBindings(worldId);
            if (expandedId) void loadFolderAssets(expandedId, true);
          }} />
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : hasNothing ? (
        <div className="rounded-2xl border border-dashed border-white/10 px-6 py-14 text-center">
          <Folder size={36} className="mx-auto text-muted-foreground/30" />
          <p className="mt-3 text-sm font-semibold text-foreground">
            {t("bindings.emptyHeadline")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("bindings.emptySubtitle")}
          </p>
          <button
            onClick={() => setShowPicker(true)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          >
            <FolderPlus size={14} />
            {t("bindings.bindFolder")}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Bound folders */}
          {bindings.map((folder) => {
            const expanded = expandedId === folder.id;
            const assets = folderAssets[folder.id] ?? [];
            const isUploading = uploadingFolderId === folder.id;
            const isDragOver = dragOverFolderId === folder.id;
            const managing = manageFolderId === folder.id;
            return (
              <div
                key={folder.id}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  setDragOverFolderId(folder.id);
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  setDragOverFolderId((prev) => (prev === folder.id ? null : prev));
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  setDragOverFolderId(null);
                  void uploadToFolder(folder.id, Array.from(e.dataTransfer.files));
                }}
                className={`library-overview-surface overflow-hidden rounded-xl transition-shadow ${
                  isDragOver ? "ring-2 ring-primary/60" : ""
                }`}
              >
                <div className="flex items-center gap-3 p-3">
                  <button
                    onClick={() => toggleFolder(folder.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    {expanded ? (
                      <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
                    )}
                    <Folder size={20} className="shrink-0 text-primary/70" />
                    <span className="truncate text-sm font-medium text-foreground">
                      {folder.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground/50">
                      {t("assets.items", { count: folder.assetCount })}
                    </span>
                  </button>

                  {/* Inline preview thumbnails when collapsed */}
                  {!expanded && folder.previewAssetIds.length > 0 && (
                    <div className="hidden items-center gap-1 sm:flex">
                      {folder.previewAssetIds.slice(0, 4).map((id) => (
                        <img
                          key={id}
                          // 36px chips. Anything but a tiny edge variant here is
                          // multiple megabytes each for a decorative strip.
                          src={cardImageUrl(getAssetCdnUrl(id), 96)}
                          alt=""
                          loading="lazy"
                          onError={fallbackToOriginalOnError}
                          className="h-9 w-9 rounded-md object-cover ring-1 ring-white/10"
                        />
                      ))}
                    </div>
                  )}

                  <button
                    onClick={() => pickFilesForFolder(folder.id)}
                    disabled={uploadingFolderId !== null}
                    title={t("bindings.uploadToFolder", { folder: folder.name })}
                    className="flex shrink-0 items-center gap-1.5 rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-white/5 hover:text-primary disabled:cursor-default disabled:opacity-60"
                  >
                    {isUploading ? (
                      <>
                        <Loader2 size={15} className="animate-spin text-primary" />
                        {uploadRemaining > 1 && (
                          <span className="text-[11px] text-primary">{uploadRemaining}</span>
                        )}
                      </>
                    ) : (
                      <Upload size={15} />
                    )}
                  </button>

                  <button
                    // R1: the folder leaves this list on unbind; the store's
                    // own pill covers a failure.
                    onClick={() => void unbind(worldId, folder.id)}
                    title={t("bindings.unbind")}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-white/5 hover:text-destructive"
                  >
                    <Unlink size={15} />
                  </button>
                </div>

                {/* Expanded asset grid */}
                {expanded && (
                  <div className="border-t border-white/5 p-3">
                    {loadingFolderId === folder.id ? (
                      <div className="flex justify-center py-6">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
                      </div>
                    ) : assets.length === 0 ? (
                      <div className="py-6 text-center">
                        <p className="text-xs text-muted-foreground/40">
                          {t("bindings.folderEmpty")}
                        </p>
                        <button
                          onClick={() => pickFilesForFolder(folder.id)}
                          disabled={uploadingFolderId !== null}
                          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-60"
                        >
                          <Upload size={13} />
                          {t("assets.upload")}
                        </button>
                      </div>
                    ) : (
                      <>
                        {/* Manage toolbar */}
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          {managing ? (
                            <>
                              <span className="text-[11px] font-medium text-primary">
                                {t("bulk.selectedCount", { count: selectedIds.size })}
                              </span>
                              <button
                                onClick={() =>
                                  setSelectedIds(new Set(assets.map((a) => a.id)))
                                }
                                className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                              >
                                {t("bulk.selectAll")}
                              </button>
                              <button
                                onClick={() => setSelectedIds(new Set())}
                                className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                              >
                                {t("bulk.clearSelection")}
                              </button>
                              <div className="ml-auto flex items-center gap-1.5">
                                <button
                                  onClick={() => setShowMovePicker(true)}
                                  disabled={selectedIds.size === 0 || bulkBusy}
                                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
                                >
                                  <FolderInput size={12} />
                                  {t("assets.moveTo")}
                                </button>
                                <button
                                  onClick={() =>
                                    setPendingDeleteIds(Array.from(selectedIds))
                                  }
                                  disabled={selectedIds.size === 0 || bulkBusy}
                                  className="flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                                >
                                  <Trash2 size={12} />
                                  {t("bulk.delete")}
                                </button>
                                <button
                                  onClick={() => toggleManage(folder.id)}
                                  title={t("bulk.cancel")}
                                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                                >
                                  <X size={13} />
                                </button>
                              </div>
                            </>
                          ) : (
                            <button
                              onClick={() => toggleManage(folder.id)}
                              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground/60 transition-colors hover:bg-white/5 hover:text-foreground"
                            >
                              <ListChecks size={12} />
                              {t("bulk.select")}
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                          {assets.map((a) => (
                            <AssetTile
                              key={a.id}
                              asset={a}
                              onCopyRef={() => void copyRef(a.id)}
                              selectable={managing}
                              selected={selectedIds.has(a.id)}
                              onToggleSelect={() => toggleSelect(a.id)}
                              onDelete={() => setPendingDeleteIds([a.id])}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Referenced loose assets */}
          {refs.length > 0 && (
            <div className="library-overview-surface rounded-xl p-3">
              <div className="mb-2 flex items-center gap-2 px-1">
                <Link2 size={15} className="text-muted-foreground/60" />
                <span className="text-xs font-semibold text-foreground">
                  {t("bindings.referencedTitle")}
                </span>
                <span className="text-[11px] text-muted-foreground/50">
                  {t("assets.items", { count: refs.length })}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {refs.map((r) => (
                  <AssetTile
                    key={r.assetId}
                    asset={{ id: r.assetId, type: r.type, filename: r.filename, url: r.url }}
                    onCopyRef={() => void copyRef(r.assetId)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Hidden file input for per-folder uploads */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          const target = uploadTargetRef.current;
          e.target.value = "";
          if (target) void uploadToFolder(target, files);
        }}
      />

      {/* Bind-folder picker */}
      <Dialog open={showPicker} onOpenChange={setShowPicker}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("bindings.pickerTitle")}</DialogTitle>
            <DialogDescription>{t("bindings.pickerDescription")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] space-y-1 overflow-y-auto py-1">
            {folders.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground/50">
                {t("bindings.noFolders")}
              </p>
            ) : (
              folders.map((f) => {
                const isBound = boundIds.has(f.id);
                return (
                  <button
                    key={f.id}
                    disabled={isBound}
                    // R1: the row turns "Bound" in place and shows up in the
                    // list behind this picker.
                    onClick={() => void bind(worldId, f.id)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      isBound
                        ? "cursor-default border-primary/30 bg-primary/5 text-muted-foreground"
                        : "border-border hover:border-primary/40 hover:bg-white/5"
                    }`}
                  >
                    <Folder size={16} className="shrink-0 text-primary/60" />
                    <span className="truncate flex-1 text-foreground">{f.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground/50">
                      {t("assets.items", { count: f.assetCount })}
                    </span>
                    {isBound && <Check size={15} className="shrink-0 text-primary" />}
                  </button>
                );
              })
            )}
          </div>
          {bindableFolders.length === 0 && folders.length > 0 && (
            <p className="text-center text-[11px] text-muted-foreground/50">
              {t("bindings.allBound")}
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={pendingDeleteIds.length > 0}
        onOpenChange={(open) => {
          if (!open && !bulkBusy) setPendingDeleteIds([]);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("bulk.deleteTitle", { count: pendingDeleteIds.length })}
            </DialogTitle>
            <DialogDescription
              dangerouslySetInnerHTML={{
                __html: t("bulk.deleteConfirmAssets", { count: pendingDeleteIds.length }),
              }}
            />
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPendingDeleteIds([])}
              disabled={bulkBusy}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
            >
              {t("bulk.cancel")}
            </button>
            <button
              onClick={() => void confirmDelete()}
              disabled={bulkBusy}
              className="flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-destructive/90 disabled:opacity-50"
            >
              {bulkBusy ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  {t("bulk.deleting")}
                </>
              ) : (
                <>
                  <Trash2 size={12} />
                  {t("bulk.delete")}
                </>
              )}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Move-target picker */}
      <Dialog
        open={showMovePicker}
        onOpenChange={(open) => {
          if (!bulkBusy) setShowMovePicker(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("assets.moveTo")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[55vh] space-y-1 overflow-y-auto py-1">
            <button
              onClick={() => void moveSelected(null)}
              disabled={bulkBusy}
              className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-white/5 disabled:opacity-50"
            >
              <FolderInput size={16} className="shrink-0 text-muted-foreground/60" />
              <span className="truncate flex-1 text-foreground">
                {t("assets.rootNoFolder")}
              </span>
            </button>
            {folders
              .filter((f) => f.id !== manageFolderId)
              .map((f) => (
                <button
                  key={f.id}
                  onClick={() => void moveSelected(f.id)}
                  disabled={bulkBusy}
                  className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-white/5 disabled:opacity-50"
                >
                  <Folder size={16} className="shrink-0 text-primary/60" />
                  <span className="truncate flex-1 text-foreground">{f.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground/50">
                    {t("assets.items", { count: f.assetCount })}
                  </span>
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AssetTile({
  asset,
  onCopyRef,
  selectable = false,
  selected = false,
  onToggleSelect,
  onDelete,
}: {
  asset: { id: string; type: string; filename: string; url: string };
  onCopyRef: () => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation("library");
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={selectable ? onToggleSelect : onCopyRef}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          (selectable ? onToggleSelect : onCopyRef)?.();
        }
      }}
      title={`${asset.filename} — @asset:${asset.id}`}
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border text-left transition-colors ${
        selected
          ? "border-primary bg-primary/10"
          : "border-white/10 hover:border-primary/40"
      }`}
    >
      <div className="flex h-16 items-center justify-center bg-black/20">
        {asset.type === "image" ? (
          <img
            src={cardImageUrl(asset.url || getAssetCdnUrl(asset.id), 400)}
            alt={asset.filename}
            loading="lazy"
            onError={fallbackToOriginalOnError}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="text-muted-foreground/40">{assetIcon(asset.type)}</div>
        )}
      </div>
      {selectable && (
        <span
          className={`absolute left-1.5 top-1.5 flex h-4.5 w-4.5 items-center justify-center rounded-full border ${
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-white/40 bg-black/40 text-transparent"
          }`}
        >
          <Check size={11} />
        </span>
      )}
      {!selectable && onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={t("assets.delete")}
          className="absolute right-1 top-1 hidden rounded-md bg-black/60 p-1 text-white/70 transition-colors hover:bg-destructive hover:text-white group-hover:block"
        >
          <Trash2 size={12} />
        </button>
      )}
      <div className="flex items-center gap-1 px-1.5 py-1">
        <span className="truncate text-[10px] text-foreground">{asset.filename}</span>
        <Copy
          size={11}
          className="ml-auto shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary"
        />
      </div>
    </div>
  );
}
