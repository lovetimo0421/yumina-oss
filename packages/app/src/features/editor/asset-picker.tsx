import { useEffect, useRef, useCallback, useState } from "react";
import {
  X,
  Upload,
  Image as ImageIcon,
  Music,
  Type,
  File,
  FileText,
  Loader2,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { useAssetStore, type Asset } from "@/stores/assets";
import { useUserAssetStore, type UserAsset } from "@/stores/user-assets";
import { getUploadMetadata } from "@/lib/asset-upload";
import { cardImageUrl, fallbackToOriginalOnError } from "@/lib/asset-url";

interface AssetPickerProps {
  worldId: string;
  filterType?: "image" | "audio" | "font" | "txt" | "other";
  onSelect: (assetRef: string) => void;
  onClose: () => void;
}

const TYPE_ICONS: Record<string, typeof ImageIcon> = {
  image: ImageIcon,
  audio: Music,
  font: Type,
  txt: FileText,
  other: File,
};

const apiBase = import.meta.env.VITE_API_URL || "";

export function AssetPicker({ worldId, filterType, onSelect, onClose }: AssetPickerProps) {
  const { t } = useTranslation("editor");
  const { assets, loading, uploading, uploadingCount, uploadProgress: progress, fetchAssets, uploadAsset } = useAssetStore();
  const {
    assets: globalAssets,
    loading: globalLoading,
    fetchAssets: fetchGlobalAssets,
  } = useUserAssetStore();
  const [search, setSearch] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchAssets(worldId);
    fetchGlobalAssets(filterType ? { type: filterType } : undefined);
  }, [worldId, fetchAssets, fetchGlobalAssets, filterType]);

  const uploadSingleFile = useCallback(async (file: File) => {
    const { type } = getUploadMetadata(file, filterType);
    const asset = await uploadAsset(worldId, file, type);
    if (asset) {
      onSelect(`@asset:${asset.id}`);
    }
  }, [filterType, onSelect, uploadAsset, worldId]);

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      await uploadSingleFile(file);
    },
    [uploadSingleFile]
  );

  const handlePanelDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setIsDraggingFiles(true);
  }, []);

  const handlePanelDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    e.stopPropagation();
    setIsDraggingFiles(false);
  }, []);

  const handlePanelDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFiles(false);

    const [file] = Array.from(e.dataTransfer.files ?? []);
    if (file) {
      await uploadSingleFile(file);
    }
  }, [uploadSingleFile]);

  // Deduplicate by id, world assets take priority
  const allAssets = (() => {
    const seen = new Set<string>();
    const combined: (Asset | UserAsset)[] = [];
    for (const a of assets) {
      if (!seen.has(a.id)) { seen.add(a.id); combined.push(a); }
    }
    for (const a of globalAssets) {
      if (!seen.has(a.id)) { seen.add(a.id); combined.push(a); }
    }
    return combined;
  })();

  const filtered = allAssets.filter((a) => {
    if (filterType && a.type !== filterType) return false;
    if (search.trim()) {
      return a.filename.toLowerCase().includes(search.toLowerCase());
    }
    return true;
  });

  const handleSelectAsset = useCallback(
    async (asset: Asset | UserAsset) => {
      // If it's a global asset, auto-create reference for this world
      const isGlobal = !assets.some((a) => a.id === asset.id);
      if (isGlobal) {
        try {
          await fetch(`${apiBase}/api/worlds/${worldId}/asset-refs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ assetId: asset.id }),
          });
        } catch {
          // Best-effort
        }
      }
      onSelect(`@asset:${asset.id}`);
    },
    [worldId, assets, onSelect]
  );

  const isLoading = loading || globalLoading;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div
        className="relative mx-4 flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl animate-in fade-in zoom-in-95 duration-200"
        onDragOver={handlePanelDragOver}
        onDragLeave={handlePanelDragLeave}
        onDrop={(e) => void handlePanelDrop(e)}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">{t("assetPicker.assetsTitle")}</h3>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search + Upload */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/30" />
            <input
              type="text"
              placeholder={t("assetPicker.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground/30 focus:border-primary/50 focus:outline-none"
            />
          </div>
          <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {uploadingCount > 1 ? `Uploading ${uploadingCount}` : uploading ? `${Math.round((progress?.fraction ?? 0) * 100)}%` : "Upload"}
            </button>
        </div>

        {/* Upload progress bar + speed */}
        {uploading && (
          <div className="flex flex-col gap-0">
            <div className="h-1 w-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-200 ease-out"
                style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }}
              />
            </div>
            {progress && progress.bytesPerSecond > 0 && (
              <div className="px-4 py-1 text-[10px] text-muted-foreground/50">
                {formatSpeed(progress.bytesPerSecond)}
                {progress.total > 0 && progress.bytesPerSecond > 0 && (
                  <span className="ml-2">
                    {formatEta((progress.total - progress.loaded) / progress.bytesPerSecond)}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={
            filterType === "image" ? "image/*" :
            filterType === "audio" ? "audio/*" :
            filterType === "font" ? ".woff,.woff2,.ttf,.otf" :
            filterType === "txt" ? "text/plain,text/markdown,text/csv,application/json,.txt,.log,.md,.markdown,.csv,.json" :
            "image/*,audio/*,.woff,.woff2,.ttf,.otf,text/plain,text/markdown,text/csv,application/json,.txt,.log,.md,.markdown,.csv,.json"
          }
          className="hidden"
          onChange={handleUpload}
        />

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-3">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground/40">
              {allAssets.length === 0
                ? t("assetPicker.noAssets")
                : t("assetPicker.noMatchingAssets")}
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {filtered.map((asset) => {
                const Icon = TYPE_ICONS[asset.type] ?? File;
                const handleClick = () => handleSelectAsset(asset);
                return (
                  <button
                    key={asset.id}
                    onClick={handleClick}
                    className={cn(
                      "flex flex-col overflow-hidden rounded-lg border border-border text-left transition-colors",
                      "hover:border-primary/30 hover:bg-primary/5"
                    )}
                  >
                    <div className="flex h-20 items-center justify-center bg-accent/30">
                      {asset.type === "image" ? (
                        <img
                          src={cardImageUrl(asset.url, 400)}
                          alt={asset.filename}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={fallbackToOriginalOnError}
                        />
                      ) : (
                        <Icon className="h-6 w-6 text-muted-foreground/20" />
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <p className="truncate text-[10px] font-medium text-foreground">
                        {asset.filename}
                      </p>
                      <p className="truncate text-[9px] font-mono text-muted-foreground/40">
                        @asset:{asset.id.slice(0, 8)}...
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {isDraggingFiles && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="rounded-2xl border border-primary/40 bg-card/90 px-6 py-8 text-center shadow-2xl">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
                <Upload className="h-6 w-6" />
              </div>
              <p className="text-sm font-semibold text-foreground">{t("assetPicker.dropToUpload")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                The uploaded asset will be selected automatically.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSecond.toFixed(0)} B/s`;
}

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `~${Math.ceil(seconds)}s left`;
  return `~${Math.ceil(seconds / 60)}m left`;
}
