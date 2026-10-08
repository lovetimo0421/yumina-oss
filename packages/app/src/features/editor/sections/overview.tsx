import { useDiscoverAccess } from "@/hooks/use-discover-access";
import { DiscoverCoverFields } from "../components/discover-cover-fields";
import { isPlaceholderCardName } from "@/lib/world-templates";
import { WorldCoverPreview } from "@/components/world-cover-previews";
import { useSession } from "@/lib/auth-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Plus, ImageIcon, Loader2, FolderOpen, Upload, Globe, Type, History, Sparkles, Volume2 } from "lucide-react";
import { FieldError } from "@/components/ui/field-error";
import { WorldUpdateHistory } from "@/features/library/world-update-history";
import { MAX_WORLD_DESCRIPTION, MAX_WORLD_NAME } from "@yumina/shared";
import { parseImportedFile } from "@/lib/import-world";
import {
  getAssetUploadErrorMessage,
  uploadAssetWithPresignedUrl,
} from "@/lib/asset-upload";
import {
  type CoverCropSettings,
} from "@/lib/cover-crop";

import { adoptOwnWriteToken, useEditorStore } from "@/stores/editor";
import { AssetPicker } from "../asset-picker";
import { VoiceField } from "../components/voice-field";
import { DebouncedInput, DebouncedTextarea } from "../components/debounced-field";
import { worldImportCounts } from "@/lib/import-summary";
import { CoverCropDialog } from "../components/cover-crop-dialog";
import { confirmAction } from "@/components/ui/global-confirm-dialog";
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

/** `embedded`: inside the canvas inspector, which already scrolls and pads. */
export function OverviewSection({ embedded = false }: { embedded?: boolean } = {}) {
  const { enabled: discoverPreview } = useDiscoverAccess();
  const { t } = useTranslation(["editor", "coverEditor"]);
  const { t: tLibrary } = useTranslation("library");
  const creator = useSession().data?.user;
  const worldDraft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const readOnlyInspect = useEditorStore(s => s.readOnlyInspect);
  const guestMode = useEditorStore(s => s.guestMode);
  const historyState = useEditorStore(s => `${s.worldStatus}:${s.pendingEdit?.status ?? ""}`);
  const saveDraft = useEditorStore(s => s.saveDraft);
  const setField = useEditorStore(s => s.setField);
  const loadWorldDefinition = useEditorStore(s => s.loadWorldDefinition);
  const galleryImages = useEditorStore(s => s.galleryImages) ?? [];
  const setGalleryImages = useEditorStore(s => s.setGalleryImages);
  const language = useEditorStore(s => s.language);
  const continuityEnabled = useEditorStore((s) => s.worldDraft.continuity?.enabled !== false);

  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploadingGallery, setUploadingGallery] = useState(false);
  const [removingIndex, setRemovingIndex] = useState<number | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [loadedGallery, setLoadedGallery] = useState(false);
  const [showCoverPicker, setShowCoverPicker] = useState(false);
  const coverTarget = useRef<"portrait" | "landscape">("portrait");
  const [showGalleryPicker, setShowGalleryPicker] = useState(false);
  // Every failure on this screen has a panel to sit in: cover problems print
  // under the cover buttons, gallery problems under the gallery grid (R4).
  // Successes need nothing — the image itself is the confirmation.
  const [coverError, setCoverError] = useState<string | null>(null);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [cropSaving, setCropSaving] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const [cropDialog, setCropDialog] = useState<{
    src?: string;
    landscapeSrc?: string;
    mode: "cover" | "gallery";
    coverCrop?: CoverCropSettings;
    landscapeCoverCrop?: CoverCropSettings;
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
        const ok = await confirmAction(t("overview.confirmReplaceWorld"), { tone: "destructive" });
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
        const counts = Object.entries(worldImportCounts(world))
          .filter(([, count]) => count > 0)
          .map(([key, count]) => t(`worldImportCounts.${key}` as never, { ns: "toasts", count }) as string);
        const summary = t("importedWorldSummary" as never, {
          ns: "toasts",
          name: world.name,
          summary: counts.length > 0 ? counts.join(", ") : (t("worldImportCounts.empty" as never, { ns: "toasts" }) as string),
        }) as string;
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
      const target = coverTarget.current;
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

        const data = await uploadAssetWithPresignedUrl<{ thumbnailUrl: string; previousUpdatedAt?: string | null; updatedAt?: string }>({
          file,
          preferredType: "image",
          resizeImageMaxDimension: 2048, // card cover — don't store the full original
          prepareUrl: `${apiBase}/api/worlds/${id}/thumbnail`,
          registerUrl: `${apiBase}/api/worlds/${id}/thumbnail/confirm`,
          registerBody: ({ key }) => ({ key, target }),
        });

        if (useEditorStore.getState().serverWorldId !== id) return;
        adoptOwnWriteToken(id, data);
        const draft = useEditorStore.getState().worldDraft;
        setField(target === "landscape" ? "landscapeCover" : "avatar", data.thumbnailUrl);
        setField(target === "landscape" ? "landscapeCoverCrop" : "coverCrop", undefined);
        if (target === "portrait") setField("galleryCoverCrop", undefined);
        setCropDialog({
          src: target === "portrait" ? data.thumbnailUrl : draft.avatar,
          landscapeSrc: target === "landscape" ? data.thumbnailUrl : draft.landscapeCover,
          mode: target === "landscape" ? "gallery" : "cover",
          coverCrop: target === "portrait" ? undefined : draft.coverCrop,
          landscapeCoverCrop: target === "landscape" ? undefined : draft.landscapeCoverCrop,
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
      const target = coverTarget.current;
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
            body: JSON.stringify({ assetId, target }),
          },
          FROM_ASSET_TIMEOUT_MS,
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setCoverError((err as { error?: string }).error || t("overview.coverFromAssetFailed"));
          return;
        }
        const { data } = await res.json();
        if (useEditorStore.getState().serverWorldId !== id) return;
        adoptOwnWriteToken(id, data);
        const draft = useEditorStore.getState().worldDraft;
        setField(target === "landscape" ? "landscapeCover" : "avatar", data.thumbnailUrl);
        setField(target === "landscape" ? "landscapeCoverCrop" : "coverCrop", undefined);
        if (target === "portrait") setField("galleryCoverCrop", undefined);
        setCropDialog({
          src: target === "portrait" ? data.thumbnailUrl : draft.avatar,
          landscapeSrc: target === "landscape" ? data.thumbnailUrl : draft.landscapeCover,
          mode: target === "landscape" ? "gallery" : "cover",
          coverCrop: target === "portrait" ? undefined : draft.coverCrop,
          landscapeCoverCrop: target === "landscape" ? undefined : draft.landscapeCoverCrop,
        });
      } catch {
        setCoverError(t("overview.coverFromAssetFailed"));
      }
    },
    [serverWorldId, saveDraft, setField, t]
  );

  const handleSaveCrop = useCallback(
    async (value: { coverCrop?: CoverCropSettings; landscapeCoverCrop?: CoverCropSettings }) => {
      if (cropSaving) return;
      setCropSaving(true);
      setCropError(null);
      // Both crops are one "save crop" action → one undo step.
      const store = useEditorStore.getState();
      try {
        store.beginBatch();
        try {
          if (cropDialog?.landscapeSrc) setField("landscapeCover", cropDialog.landscapeSrc);
          setField("coverCrop", value.coverCrop);
          setField("landscapeCoverCrop", value.landscapeCoverCrop);
        } finally {
          store.commitBatch();
        }
        if (!await store.saveDraft()) {
          setCropError(t("coverEditor:extra.crop.saveFailed"));
          return;
        }
        setCropDialog(null);
      } catch {
        setCropError(t("coverEditor:extra.crop.saveFailed"));
      } finally {
        setCropSaving(false);
      }
    },
    [setField, cropDialog, cropSaving, t]
  );

  const coverCrop = worldDraft.coverCrop;
  const landscapeCoverCrop = worldDraft.landscapeCoverCrop;

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

        if (useEditorStore.getState().galleryImages.length >= 8) {
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
        // Append to the LATEST list, not the one captured when this upload
        // started — two uploads in flight used to each append to the same
        // stale array and the second overwrote the first.
        setGalleryImages([...useEditorStore.getState().galleryImages, data.url]);
      } catch {
        setGalleryError(t("overview.galleryAddFailed"));
      }
    },
    [serverWorldId, saveDraft, setGalleryImages, t]
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

        if (useEditorStore.getState().galleryImages.length >= 8) {
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

        // Latest list, not the closure's (see handleGalleryFromAsset). The
        // server's own galleryImages holds raw storage keys while the store
        // holds display URLs, so it can't be dropped in as-is.
        setGalleryImages([...useEditorStore.getState().galleryImages, data.url]);
      } catch (error) {
        setGalleryError(getAssetUploadErrorMessage(error));
      } finally {
        setUploadingGallery(false);
      }
    },
    [serverWorldId, saveDraft, setGalleryImages, t]
  );

  const handleRemoveGalleryImage = useCallback(
    async (index: number) => {
      if (!serverWorldId) return;
      // The server deletes by index, so remember WHICH image was clicked and
      // remove that one from the latest list afterwards — filtering the
      // closure's array by index could drop an image added meanwhile.
      const removedUrl = useEditorStore.getState().galleryImages[index];
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
        const latest = useEditorStore.getState().galleryImages;
        const at = removedUrl !== undefined ? latest.indexOf(removedUrl) : -1;
        setGalleryImages(latest.filter((_, i) => i !== (at >= 0 ? at : index)));
      } catch {
        setGalleryError(t("overview.imageRemoveFailed"));
      } finally {
        setRemovingIndex(null);
      }
    },
    [serverWorldId, setGalleryImages, t]
  );

  return (
    <div className={embedded ? "@container" : "@container flex-1 overflow-y-auto p-6"}>
      <div className={embedded ? "space-y-6" : "mx-auto max-w-3xl space-y-8"}>
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
              {t("overview.worldTitle")}
            </label>
            <span className="shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground/60">
              {(isPlaceholderCardName(worldDraft.name) ? "" : worldDraft.name ?? "").length}/{MAX_WORLD_NAME}
            </span>
          </div>
          <div className="relative">
            <Type className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground/55" />
            <DebouncedInput
              id="overview-world-title"
              type="text"
              value={isPlaceholderCardName(worldDraft.name) ? "" : worldDraft.name}
              onCommit={(name) => setField("name", name)}
              placeholder={t("shell.namePlaceholder")}
              maxLength={MAX_WORLD_NAME}
              className="w-full rounded-xl border border-border bg-card py-4 pl-12 pr-4 text-xl font-semibold text-foreground outline-none transition-colors placeholder:text-muted-foreground/30 focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <section className="rounded-lg border border-border bg-background p-5" aria-labelledby="overview-update-history-title">
          {serverWorldId ? (
            <WorldUpdateHistory
              key={`${serverWorldId}:${historyState}`}
              worldId={serverWorldId}
              canEdit={!readOnlyInspect && !guestMode}
              showCreateButton
              heading={(
                <h3 id="overview-update-history-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <History className="h-4 w-4 text-primary" aria-hidden="true" />
                  {tLibrary("detail.updateHistory")}
                </h3>
              )}
            />
          ) : (
            <>
            <h3 id="overview-update-history-title" className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
              <History className="h-4 w-4 text-primary" aria-hidden="true" />
              {tLibrary("detail.updateHistory")}
            </h3>
            <p className="py-6 text-center text-sm text-muted-foreground">{tLibrary("detail.updateHistorySaveFirst")}</p>
            </>
          )}
        </section>

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
        {discoverPreview ? <DiscoverCoverFields /> : <div data-learn="ov-cover" className="rounded-lg border border-border bg-background p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-foreground">{t("overview.coverImage")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground/50">
              {t("overview.coverImageDesc")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 @[480px]:grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)]">
            {(["portrait", "landscape"] as const).map((target) => {
              const portrait = target === "portrait";
              const source = portrait ? worldDraft.avatar : worldDraft.landscapeCover;
              const openCrop = (landscapeSrc = worldDraft.landscapeCover) => setCropDialog({
                src: worldDraft.avatar, landscapeSrc, mode: portrait ? "cover" : "gallery",
                coverCrop, landscapeCoverCrop: landscapeSrc === worldDraft.landscapeCover ? landscapeCoverCrop : undefined,
              });
              return <section key={target} className="min-w-0" aria-label={t(portrait ? "extra.crop.phone" : "extra.crop.desktop")}>
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h4 className="text-sm font-medium">{t(portrait ? "extra.crop.phone" : "extra.crop.desktop")}</h4>
                  <span className="text-[11px] text-muted-foreground">{portrait ? "1000 × 1500" : "1600 × 900"}</span>
                </div>
                <button type="button" disabled={uploadingCover} onClick={() => {
                  coverTarget.current = target;
                  if (source) openCrop(); else coverFileRef.current?.click();
                }} aria-label={t(portrait ? "extra.crop.phone" : "extra.crop.desktop")} className={`relative w-full overflow-hidden rounded-lg border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring ${portrait ? "max-w-52" : ""} ${source ? "block" : "flex aspect-video items-center justify-center"}`}>
                  {source ? <WorldCoverPreview src={source} crop={portrait ? coverCrop : landscapeCoverCrop} shape={target}
                    details={{ title: worldDraft.name, description: worldDraft.description, creatorName: creator?.name, creatorImage: creator?.image }} />
                    : <span className="flex flex-col items-center gap-2 px-4 text-center text-xs text-muted-foreground"><ImageIcon className="h-7 w-7 opacity-40" />{t("overview.uploadCover")}</span>}
                </button>
                <p className="mb-3 mt-2 text-xs leading-relaxed text-muted-foreground">{t(portrait ? "overview.portraitUse" : "overview.landscapeUse")}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={uploadingCover} onClick={() => { coverTarget.current = target; coverFileRef.current?.click(); }}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs hover:bg-accent disabled:opacity-40">
                    {uploadingCover && coverTarget.current === target ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    {t(source ? "overview.changeCover" : "overview.uploadCover")}
                  </button>
                  <button type="button" disabled={uploadingCover} onClick={async () => {
                    coverTarget.current = target;
                    if (!serverWorldId) await saveDraft();
                    if (useEditorStore.getState().serverWorldId) setShowCoverPicker(true);
                    else setCoverError(t("overview.saveWorldForAssets"));
                  }} className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs hover:bg-accent">
                    <FolderOpen className="h-3.5 w-3.5" />{t("overview.fromAssets")}
                  </button>
                  {source && <button type="button" onClick={() => openCrop()} className="min-h-9 px-1 text-xs text-primary hover:underline">{t("extra.adjustCoverCrop")}</button>}
                </div>
                {!portrait && worldDraft.avatar && !source && <button type="button" onClick={() => openCrop(worldDraft.avatar)}
                  className="mt-3 min-h-9 text-left text-xs text-primary hover:underline">{t("overview.reusePortrait")}</button>}
                {!portrait && !source && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("overview.landscapeNeeded")}</p>}
              </section>;
            })}
          </div>
          <FieldError id="cover-error" message={coverError} />
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
        </div>}

        {/* Gallery Images */}
        <div data-learn="ov-gallery" className="rounded-lg border border-border bg-background p-5">
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
          <DebouncedTextarea
            value={worldDraft.description}
            onCommit={(description) => setField("description", description)}
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
        <div data-learn="ov-language" className="rounded-lg border border-border bg-background p-5">
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

        {/* Continuity judge — the one switch authors see. Default on. */}
        <div className="rounded-lg border border-border bg-background p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-foreground">{t("overview.continuity")}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground/50">
                {t("overview.continuityDesc")}
              </p>
            </div>
            <input
              type="checkbox"
              aria-label={t("overview.continuity")}
              checked={continuityEnabled}
              onChange={(e) => useEditorStore.getState().updateContinuity({ enabled: e.target.checked ? undefined : false })}
              className="h-5 w-5 shrink-0 accent-primary"
            />
          </div>
        </div>

        {/* Voice — what readout and voice input do on this card */}
        <div className="rounded-lg border border-border bg-background p-5">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Volume2 className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-foreground">{t("voiceField.cardTitle")}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground/50">{t("voiceField.cardDesc")}</p>
            </div>
          </div>
          <div className="space-y-5">
            <VoiceField
              label={t("voiceField.narratorLabel")}
              hint={t("voiceField.narratorHint")}
              title={t("blueprint.voice.narrator")}
              value={worldDraft.settings?.narratorVoice}
              onChange={(narratorVoice: string | undefined) => {
                const store = useEditorStore.getState();
                store.setField("settings", { ...store.worldDraft.settings, narratorVoice });
              }}
            />
            <div className="space-y-2">
              <label className="text-sm font-bold text-foreground">{t("blueprint.voice.inputTitle")}</label>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t("blueprint.voice.inputTitle")}>
                {(["confirm", "auto"] as const).map((m) => {
                  const active = (worldDraft.settings?.voiceInputMode ?? "confirm") === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        const store = useEditorStore.getState();
                        store.setField("settings", { ...store.worldDraft.settings, voiceInputMode: m });
                      }}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${active ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                    >
                      {t(m === "auto" ? "blueprint.voice.inputAuto" : "blueprint.voice.inputConfirm")}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">{t("blueprint.voice.inputHint")}</p>
            </div>
          </div>
        </div>

        {/* Variant Group removed — variant management is now in the tab bar above */}
      </div>

      {cropDialog && (
        <CoverCropDialog
          src={cropDialog.src}
          landscapeSrc={cropDialog.landscapeSrc}
          details={{ title: worldDraft.name, description: worldDraft.description, creatorName: creator?.name, creatorImage: creator?.image }}
          initialMode={cropDialog.mode}
          initialCoverCrop={cropDialog.coverCrop}
          initialLandscapeCrop={cropDialog.landscapeCoverCrop}
          saving={cropSaving}
          error={cropError ?? undefined}
          onCancel={() => { if (!cropSaving) { setCropDialog(null); setCropError(null); } }}
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
