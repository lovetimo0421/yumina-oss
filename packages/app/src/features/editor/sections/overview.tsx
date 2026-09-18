import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Plus, ImageIcon, Loader2, Camera, FolderOpen, Upload, Globe, Type } from "lucide-react";
import { FieldError } from "@/components/ui/field-error";
import { MAX_WORLD_DESCRIPTION, MAX_WORLD_NAME } from "@yumina/shared";
import { parseImportedFile } from "@/lib/import-world";
import {
  getAssetUploadErrorMessage,
  uploadAssetWithPresignedUrl,
} from "@/lib/asset-upload";
import {
  CroppedImage,
  normalizeCoverCrop,
  type CoverCropSettings,
} from "@/lib/cover-crop";
import { getWorldGalleryDisplayCrop } from "@/lib/world-cover-crop";
import { useEditorStore } from "@/stores/editor";
import { AssetPicker } from "../asset-picker";
import { CoverCropDialog } from "../components/cover-crop-dialog";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";


const apiBase = import.meta.env.VITE_API_URL || "";

const FROM_ASSET_TIMEOUT_MS = 20_000;

function fetchWithTimeout(input: RequestInfo, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
}

export function OverviewSection() {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const saveDraft = useEditorStore(s => s.saveDraft);
  const setField = useEditorStore(s => s.setField);
  const loadWorldDefinition = useEditorStore(s => s.loadWorldDefinition);
  const galleryImages = useEditorStore(s => s.galleryImages) ?? [];
  const setGalleryImages = useEditorStore(s => s.setGalleryImages);
  const language = useEditorStore(s => s.language);

  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploadingGallery, setUploadingGallery] = useState(false);
  const [removingIndex, setRemovingIndex] = useState<number | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [loadedGallery, setLoadedGallery] = useState(false);
  const [showCoverPicker, setShowCoverPicker] = useState(false);
  const [showGalleryPicker, setShowGalleryPicker] = useState(false);
  // Every failure on this screen has a panel to sit in: cover problems print
  // under the cover buttons, gallery problems under the gallery grid (R4).
  // Successes need nothing — the image itself is the confirmation.
  const [coverError, setCoverError] = useState<string | null>(null);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [cropDialog, setCropDialog] = useState<{
    src: string;
    coverCrop: CoverCropSettings;
    galleryCoverCrop: CoverCropSettings;
  } | null>(null);
  const coverFileRef = useRef<HTMLInputElement>(null);
  const galleryFileRef = useRef<HTMLInputElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const handleImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }

      // When called from inside the editor of an existing/published world,
      // we MUST keep `serverWorldId` so:
      //   1. The route page (`worlds.$worldId.edit`) doesn't get stuck on its
      //      loading spinner because `serverWorldId !== worldId`.
      //   2. The next save PATCHes the existing world instead of creating
      //      a new one (which would orphan the published card).
      const isReplacingExisting = !!serverWorldId;
      if (isReplacingExisting) {
        const ok = window.confirm(t("overview.confirmReplaceWorld"));
        if (!ok) {
          e.target.value = "";
          return;
        }
      }

      try {
        const { world, coverImage } = await parseImportedFile(file, { sourceHint: "yumina" });
        loadWorldDefinition(world, {
          preserveServerState: isReplacingExisting,
        });
        if (coverImage) {
          // Use the PNG card image as the cover (saves the world first if new).
          await useEditorStore.getState().applyImportedCover(coverImage);
        }
        const entryCount = world.entries.length;
        const variableCount = world.variables.length;
        const ruleCount = world.rules.length;
        const componentCount = world.components.length;
        const audioCount = (world.audioTracks ?? []).length;
        const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
        const summary = `Imported "${world.name}" (${n(entryCount, "entry", "entries")}, ${n(variableCount, "variable", "variables")}, ${n(ruleCount, "rule", "rules")}, ${n(componentCount, "component", "components")}, ${audioCount} audio)`;
        // Replacing a live card needs a save to take effect — say so in the
        // same line, where the creator is already reading the result.
        setImportResult(
          isReplacingExisting
            ? `${summary} — ${t("overview.importReplacedSaveReminder")}`
            : summary
        );
      } catch (error) {
        setImportResult(
          error instanceof Error
            ? error.message
            : t("extra.failedParseWorld")
        );
      } finally {
        e.target.value = "";
      }
    },
    [loadWorldDefinition, serverWorldId, t]
  );

  const handleCoverUpload = useCallback(
    async (file: File) => {
      setUploadingCover(true);
      setCoverError(null);
      try {
        let id = serverWorldId;
        if (!id) {
          await saveDraft();
          id = useEditorStore.getState().serverWorldId;
        }
        if (!id) {
          setCoverError(t("overview.saveWorldForCover"));
          return;
        }

        const data = await uploadAssetWithPresignedUrl<{ thumbnailUrl: string }>({
          file,
          preferredType: "image",
          resizeImageMaxDimension: 2048, // card cover — don't store the full original
          prepareUrl: `${apiBase}/api/worlds/${id}/thumbnail`,
          registerUrl: `${apiBase}/api/worlds/${id}/thumbnail/confirm`,
          registerBody: ({ key }) => ({ key }),
        });

        setField("avatar", data.thumbnailUrl);
        setCropDialog({
          src: data.thumbnailUrl,
          coverCrop: normalizeCoverCrop(useEditorStore.getState().worldDraft.coverCrop),
          galleryCoverCrop: normalizeCoverCrop(useEditorStore.getState().worldDraft.galleryCoverCrop),
        });
      } catch (error) {
        setCoverError(getAssetUploadErrorMessage(error));
      } finally {
        setUploadingCover(false);
      }
    },
    [serverWorldId, saveDraft, setField, t]
  );

  const handleCoverFromAsset = useCallback(
    async (assetRef: string) => {
      const match = assetRef.match(/@asset:(.+)/);
      if (!match) return;
      const assetId = match[1]!;

      setCoverError(null);
      try {
        let id = serverWorldId;
        if (!id) {
          await saveDraft();
          id = useEditorStore.getState().serverWorldId;
        }
        if (!id) {
          setCoverError(t("overview.saveWorldFirst"));
          return;
        }

        const res = await fetchWithTimeout(
          `${apiBase}/api/worlds/${id}/thumbnail/from-asset`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ assetId }),
          },
          FROM_ASSET_TIMEOUT_MS,
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setCoverError((err as { error?: string }).error || t("overview.coverFromAssetFailed"));
          return;
        }
        const { data } = await res.json();
        setField("avatar", data.thumbnailUrl);
        setCropDialog({
          src: data.thumbnailUrl,
          coverCrop: normalizeCoverCrop(useEditorStore.getState().worldDraft.coverCrop),
          galleryCoverCrop: normalizeCoverCrop(useEditorStore.getState().worldDraft.galleryCoverCrop),
        });
      } catch {
        setCoverError(t("overview.coverFromAssetFailed"));
      }
    },
    [serverWorldId, saveDraft, setField, t]
  );

  const handleSaveCrop = useCallback(
    async (value: { coverCrop: CoverCropSettings; galleryCoverCrop: CoverCropSettings }) => {
      setField("coverCrop", value.coverCrop);
      setField("galleryCoverCrop", getWorldGalleryDisplayCrop(value.galleryCoverCrop));
      setCropDialog(null);
      // The cover preview above re-renders with the new crop and the header
      // shows the save — nothing else to announce.
      await useEditorStore.getState().saveDraft();
    },
    [setField]
  );

  const coverCrop = normalizeCoverCrop(worldDraft.coverCrop);
  const galleryCoverCrop = getWorldGalleryDisplayCrop(worldDraft.galleryCoverCrop);

  const handleGalleryFromAsset = useCallback(
    async (assetRef: string) => {
      const match = assetRef.match(/@asset:(.+)/);
      if (!match) return;
      const assetId = match[1]!;

      setGalleryError(null);
      try {
        let id = serverWorldId;
        if (!id) {
          await saveDraft();
          id = useEditorStore.getState().serverWorldId;
        }
        if (!id) {
          setGalleryError(t("overview.saveWorldFirst"));
          return;
        }

        if (galleryImages.length >= 8) {
          setGalleryError(t("overview.maxGalleryError"));
          return;
        }

        const res = await fetchWithTimeout(
          `${apiBase}/api/worlds/${id}/gallery/from-asset`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ assetId }),
          },
          FROM_ASSET_TIMEOUT_MS,
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setGalleryError((err as { error?: string }).error || t("overview.galleryAddFailed"));
          return;
        }
        const { data } = await res.json();
        setGalleryImages([...galleryImages, data.url]);
      } catch {
        setGalleryError(t("overview.galleryAddFailed"));
      }
    },
    [serverWorldId, saveDraft, galleryImages, setGalleryImages, t]
  );

  // Load gallery images from server on mount (they're presigned URLs)
  useEffect(() => {
    if (!serverWorldId || loadedGallery) return;
    setLoadedGallery(true);
    // Gallery images are already loaded via loadWorld into the store
  }, [serverWorldId, loadedGallery]);

  const handleGalleryUpload = useCallback(
    async (file: File) => {
      setUploadingGallery(true);
      setGalleryError(null);
      try {
        let id = serverWorldId;
        if (!id) {
          await saveDraft();
          id = useEditorStore.getState().serverWorldId;
        }
        if (!id) {
          setGalleryError(t("overview.saveWorldForGallery"));
          return;
        }

        if (galleryImages.length >= 8) {
          setGalleryError(t("overview.maxGalleryError"));
          return;
        }

        const data = await uploadAssetWithPresignedUrl<{ url: string; galleryImages: string[] }>({
          file,
          preferredType: "image",
          prepareUrl: `${apiBase}/api/worlds/${id}/gallery/upload-url`,
          registerUrl: `${apiBase}/api/worlds/${id}/gallery/confirm`,
          registerBody: ({ key }) => ({ key }),
        });

        setGalleryImages([...galleryImages, data.url]);
      } catch (error) {
        setGalleryError(getAssetUploadErrorMessage(error));
      } finally {
        setUploadingGallery(false);
      }
    },
    [serverWorldId, saveDraft, galleryImages, setGalleryImages, t]
  );

  const handleRemoveGalleryImage = useCallback(
    async (index: number) => {
      if (!serverWorldId) return;
      setRemovingIndex(index);
      setGalleryError(null);
      try {
        const res = await fetch(
          `${apiBase}/api/worlds/${serverWorldId}/gallery/${index}`,
          {
            method: "DELETE",
            credentials: "include",
          }
        );
        if (!res.ok) {
          setGalleryError(t("overview.imageRemoveFailed"));
          return;
        }
        // The tile leaves the grid — that is the confirmation.
        const updated = galleryImages.filter((_, i) => i !== index);
        setGalleryImages(updated);
      } catch {
        setGalleryError(t("overview.imageRemoveFailed"));
      } finally {
        setRemovingIndex(null);
      }
    },
    [serverWorldId, galleryImages, setGalleryImages, t]
  );

  return (
    <div className="@container flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("overview.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground/50">
            {t("overview.description")}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-background p-5" data-tour="overview-title-card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <label
              htmlFor="overview-world-title"
              className="text-sm font-semibold text-foreground"
            >
              {t("overview.worldTitle", { defaultValue: "World title" })}
            </label>
            <span className="shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground/60">
              {(worldDraft.name ?? "").length}/{MAX_WORLD_NAME}
            </span>
          </div>
          <div className="relative">
            <Type className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground/55" />
            <input
              id="overview-world-title"
              type="text"
              value={worldDraft.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder={t("shell.namePlaceholder")}
              maxLength={MAX_WORLD_NAME}
              className="w-full rounded-xl border border-border bg-card py-4 pl-12 pr-4 text-xl font-semibold text-foreground outline-none transition-colors placeholder:text-muted-foreground/30 focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="rounded-lg border border-border bg-background p-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-foreground">{t("overview.importJson")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground/50">
              {t("overview.importJsonDesc")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={importFileRef}
              type="file"
              accept=".json,.png"
              onChange={handleImport}
              className="hidden"
            />
            <button
              onClick={() => importFileRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Upload className="h-3.5 w-3.5" />
              {t("overview.chooseFile")}
            </button>
            {importResult && (
              <span className="text-xs text-muted-foreground/60">
                {importResult}
              </span>
            )}
          </div>
        </div>

        {/* Cover Image */}
        <div className="rounded-lg border border-border bg-background p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-foreground">{t("overview.coverImage")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground/50">
              {t("overview.coverImageDesc")}
            </p>
          </div>
          <div className="flex flex-col @[480px]:flex-row @[480px]:items-start gap-4 @[480px]:gap-6">
            <div className="group relative h-40 w-40 shrink-0 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
              {worldDraft.avatar ? (
                <>
                  <div className="absolute inset-0 z-10 bg-black/40 transition-colors group-hover:bg-black/20" />
                  <CroppedImage
                    src={worldDraft.avatar}
                    alt="Cover"
                    crop={coverCrop}
                    className="h-full w-full"
                  />
                </>
              ) : (
                <>
                  <div className="absolute inset-0 z-10 bg-black/20 transition-colors group-hover:bg-black/10" />
                  <div className="flex h-full w-full items-center justify-center bg-card">
                    <ImageIcon className="h-10 w-10 text-muted-foreground/20" />
                  </div>
                </>
              )}
              <div className="touch-reveal absolute inset-0 z-20 flex items-center justify-center opacity-0 backdrop-blur-[2px] transition-opacity group-hover:opacity-100">
                <button
                  onClick={() => coverFileRef.current?.click()}
                  disabled={uploadingCover}
                  className="flex items-center gap-2 rounded-lg border border-border bg-black/60 px-3 py-2 text-xs font-medium text-foreground shadow-lg transition-all hover:border-primary/50 hover:bg-black/80 hover:text-primary disabled:opacity-50"
                >
                  {uploadingCover ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Camera className="h-4 w-4" />
                  )}
                  {uploadingCover ? t("overview.uploading") : t("overview.change")}
                </button>
              </div>
              {uploadingCover && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 pt-2">
              {worldDraft.avatar && (
                <div className="mb-2 w-48 max-w-full rounded-lg border border-border bg-card p-2">
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
                    Gallery preview
                  </p>
                  <CroppedImage
                    src={worldDraft.avatar}
                    alt="Gallery preview"
                    crop={galleryCoverCrop}
                    className="aspect-video w-full rounded-md border border-border"
                  />
                </div>
              )}
              <button
                onClick={() => coverFileRef.current?.click()}
                disabled={uploadingCover}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                {/* The cover tile has its own spinner overlay; this button is the
                    other way in, so it shows the upload in place too (R6/T0 —
                    progress on the control, no pill). */}
                {uploadingCover ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Camera className="h-3.5 w-3.5" />
                )}
                {uploadingCover
                  ? t("overview.uploading")
                  : worldDraft.avatar
                    ? t("overview.changeCover")
                    : t("overview.uploadCover")}
              </button>
              <button
                onClick={async () => {
                  setCoverError(null);
                  if (!serverWorldId) {
                    await saveDraft();
                    if (!useEditorStore.getState().serverWorldId) {
                      setCoverError(t("overview.saveWorldForAssets"));
                      return;
                    }
                  }
                  setShowCoverPicker(true);
                }}
                className="flex items-center gap-2 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-3 py-1.5 text-sm font-medium text-primary/70 transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-primary"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t("overview.fromAssets")}
              </button>
              {worldDraft.avatar && (
                <button
                  onClick={() =>
                    setCropDialog({
                      src: worldDraft.avatar!,
                      coverCrop,
                      galleryCoverCrop,
                    })
                  }
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  Adjust crop
                </button>
              )}
              <p className="text-xs text-muted-foreground/40">
                {t("overview.imageFormats")}
              </p>
              <FieldError id="cover-error" message={coverError} />
            </div>
          </div>
          <input
            ref={coverFileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleCoverUpload(file);
              e.target.value = "";
            }}
          />
        </div>

        {/* Gallery Images */}
        <div className="rounded-lg border border-border bg-background p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {t("overview.galleryImages")}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground/50">
                {t("overview.galleryImagesDesc")}
              </p>
            </div>
            <span className="text-xs text-muted-foreground/40">
              {galleryImages.length}/8
            </span>
          </div>

          <div className="grid grid-cols-2 @[640px]:grid-cols-4 gap-3">
            {galleryImages.map((url, index) => (
              <div
                key={`${index}-${url}`}
                className="group relative aspect-video overflow-hidden rounded-lg border border-border bg-card"
              >
                <img
                  src={url}
                  alt={`Gallery ${index + 1}`}
                  className="h-full w-full object-cover"
                />
                <TwoTapDeleteButton
                  onConfirm={() => handleRemoveGalleryImage(index)}
                  disabled={removingIndex === index}
                  className="touch-reveal absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-red-600 active:bg-red-600 group-hover:opacity-100 disabled:opacity-50 [@media(hover:none)]:h-9 [@media(hover:none)]:w-9"
                  armedClassName="opacity-100 bg-red-600"
                  armedTitle={t("twoTapConfirm")}
                >
                  {removingIndex === index ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                </TwoTapDeleteButton>
              </div>
            ))}

            {galleryImages.length < 8 && (
              <>
                <button
                  onClick={() => galleryFileRef.current?.click()}
                  disabled={uploadingGallery}
                  className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-border bg-card text-muted-foreground/40 transition-colors hover:border-primary/50 hover:text-primary/60 disabled:opacity-50"
                >
                  {uploadingGallery ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : (
                    <div className="flex flex-col items-center gap-1">
                      <Plus className="h-5 w-5" />
                      <span className="text-[10px] font-medium">{t("overview.upload")}</span>
                    </div>
                  )}
                </button>
                <button
                  onClick={async () => {
                    setGalleryError(null);
                    if (!serverWorldId) {
                      await saveDraft();
                      if (!useEditorStore.getState().serverWorldId) {
                        setGalleryError(t("overview.saveWorldForAssets"));
                        return;
                      }
                    }
                    setShowGalleryPicker(true);
                  }}
                  className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-primary/30 bg-primary/5 text-primary/40 transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-primary/60"
                >
                  <div className="flex flex-col items-center gap-1">
                    <FolderOpen className="h-5 w-5" />
                    <span className="text-[10px] font-medium">{t("overview.fromAssets")}</span>
                  </div>
                </button>
              </>
            )}
          </div>

          {galleryImages.length === 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground/40">
              <ImageIcon className="h-3.5 w-3.5" />
              {t("overview.noGalleryImages")}
            </div>
          )}

          <FieldError id="gallery-error" message={galleryError} />

          <input
            ref={galleryFileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleGalleryUpload(file);
              e.target.value = "";
            }}
          />
        </div>

        {/* Description */}
        <div className="rounded-lg border border-border bg-background p-5" data-tour="overview-description">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-foreground">
              {t("overview.descriptionTitle")}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground/50">
              {t("overview.descriptionDesc")}
            </p>
          </div>
          <textarea
            value={worldDraft.description}
            onChange={(e) => setField("description", e.target.value)}
            placeholder={t("overview.descriptionPlaceholder")}
            rows={8}
            maxLength={MAX_WORLD_DESCRIPTION}
            className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="mt-1 flex items-center justify-between">
            <p className="text-xs text-muted-foreground/40">
              {t("overview.markdownSupported")}
            </p>
            <span className="text-xs text-muted-foreground/30">
              {(worldDraft.description ?? "").length}/{MAX_WORLD_DESCRIPTION}
            </span>
          </div>
        </div>

        {/* Language */}
        <div className="rounded-lg border border-border bg-background p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Globe className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-foreground">{t("overview.language")}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground/50">
                {t("overview.languageDesc")}
              </p>
            </div>
            <select
              value={language ?? ""}
              onChange={(e) => useEditorStore.getState().setLanguage(e.target.value || null)}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">—</option>
              <option value="en">English</option>
              <option value="zh">中文</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
              <option value="pt">Português</option>
              <option value="ru">Русский</option>
            </select>
          </div>
        </div>

        {/* Variant Group removed — variant management is now in the tab bar above */}
      </div>

      {cropDialog && (
        <CoverCropDialog
          src={cropDialog.src}
          initialCoverCrop={cropDialog.coverCrop}
          initialGalleryCrop={cropDialog.galleryCoverCrop}
          onCancel={() => setCropDialog(null)}
          onSave={handleSaveCrop}
        />
      )}

      {showCoverPicker && (serverWorldId || useEditorStore.getState().serverWorldId) && (
        <AssetPicker
          worldId={(serverWorldId || useEditorStore.getState().serverWorldId)!}
          filterType="image"
          onSelect={(ref) => {
            handleCoverFromAsset(ref);
            setShowCoverPicker(false);
          }}
          onClose={() => setShowCoverPicker(false)}
        />
      )}

      {showGalleryPicker && (serverWorldId || useEditorStore.getState().serverWorldId) && (
        <AssetPicker
          worldId={(serverWorldId || useEditorStore.getState().serverWorldId)!}
          filterType="image"
          onSelect={(ref) => {
            handleGalleryFromAsset(ref);
            setShowGalleryPicker(false);
          }}
          onClose={() => setShowGalleryPicker(false)}
        />
      )}
    </div>
  );
}
