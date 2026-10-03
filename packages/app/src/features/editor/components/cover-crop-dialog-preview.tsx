import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { Check, Maximize2, Minimize2, Move, RotateCcw, X } from "lucide-react";
import {
  DEFAULT_COVER_CROP,
  MAX_CROP_SIZE,
  MIN_CROP_SIZE,
  clampCoverCrop,
  clampCoverCropForAspect,
  getCoverCropRect,
  type CoverCropSettings,
} from "@/lib/cover-crop";
import { DISCOVER_COVER_ASPECTS } from "@/lib/discover-world-artwork";
import { resolveImageUrl } from "@/lib/asset-url";
import { WorldCoverPreviews, type CoverPreviewDetails, type CoverPlacementPreview } from "@/components/world-cover-previews";

interface CoverCropDialogProps {
  src?: string;
  landscapeSrc?: string;
  initialMode?: CropMode;
  details?: CoverPreviewDetails;
  placements?: CoverPlacementPreview[];
  saving?: boolean;
  error?: string;
  initialCoverCrop?: CoverCropSettings | null;
  initialLandscapeCrop?: CoverCropSettings | null;
  /** Display legacy wide framing without confirming it until the wide view is saved. */
  fallbackLandscapeCrop?: CoverCropSettings | null;
  onCancel: () => void;
  onSave: (value: {
    activeMode: CropMode;
    coverCrop?: CoverCropSettings;
    landscapeCoverCrop?: CoverCropSettings;
  }) => void;
}

type CropMode = "cover" | "gallery";

function getTargetAspect(mode: CropMode) {
  return DISCOVER_COVER_ASPECTS[mode];
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toPercentCrop(
  crop: CoverCropSettings,
  sourceAspect: number,
  targetAspect: number,
): PercentCrop {
  const rect = getCoverCropRect(crop, sourceAspect, targetAspect);
  return {
    unit: "%",
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function fromPercentCrop(
  crop: PercentCrop,
  sourceAspect: number,
  targetAspect: number,
): CoverCropSettings {
  const fullRect = getCoverCropRect(DEFAULT_COVER_CROP, sourceAspect, targetAspect);
  const width = clamp(Number(crop.width), 0, 100);
  const height = clamp(Number(crop.height), 0, 100);
  const widthZoom = fullRect.width > 0 ? width / fullRect.width : 1;
  const heightZoom = fullRect.height > 0 ? height / fullRect.height : 1;

  return clampCoverCropForAspect(
    {
      x: clamp(Number(crop.x), 0, 100 - width) + width / 2 - 50,
      y: clamp(Number(crop.y), 0, 100 - height) + height / 2 - 50,
      zoom: clamp(Math.min(widthZoom, heightZoom), MIN_CROP_SIZE, MAX_CROP_SIZE),
      fit: "cover",
    },
    sourceAspect,
    targetAspect,
  );
}

export function CoverCropDialog({
  src,
  landscapeSrc,
  initialMode = "cover",
  details,
  placements,
  saving = false,
  error,
  initialCoverCrop,
  initialLandscapeCrop,
  fallbackLandscapeCrop,
  onCancel,
  onSave,
}: CoverCropDialogProps) {
  const { t } = useTranslation("coverEditor");
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const [mode, setMode] = useState<CropMode>(initialMode);
  // Keep absent and explicit crops distinct, and never clamp an untouched view.
  const [coverCrop, setCoverCrop] = useState<CoverCropSettings | undefined>(initialCoverCrop ?? undefined);
  const [landscapeCoverCrop, setLandscapeCoverCrop] = useState<CoverCropSettings | undefined>(initialLandscapeCrop ?? undefined);
  const [imageFailed, setImageFailed] = useState(false);
  const [sourceAspect, setSourceAspect] = useState<number | null>(null);
  const activeTargetAspect = getTargetAspect(mode);
  const activeSrc = mode === "gallery" ? landscapeSrc : src;
  const activeCrop = { ...clampCoverCrop((mode === "cover" ? coverCrop : landscapeCoverCrop ?? fallbackLandscapeCrop) ?? DEFAULT_COVER_CROP), fit: "cover" as const };
  const wholeImage = false;
  const safeSourceAspect = sourceAspect ?? activeTargetAspect;
  const activePercentCrop = useMemo(
    () => toPercentCrop(activeCrop, safeSourceAspect, activeTargetAspect),
    [activeCrop, activeTargetAspect, safeSourceAspect],
  );
  useEffect(() => {
    const scrollY = window.scrollY;
    const originalStyle = {
      htmlOverflow: document.documentElement.style.overflow,
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";

    return () => {
      document.documentElement.style.overflow = originalStyle.htmlOverflow;
      document.body.style.overflow = originalStyle.overflow;
      document.body.style.position = originalStyle.position;
      document.body.style.top = originalStyle.top;
      document.body.style.width = originalStyle.width;
      window.scrollTo(0, scrollY);
    };
  }, []);
  const setActiveCrop = useCallback(
    (next: CoverCropSettings | ((current: CoverCropSettings) => CoverCropSettings)) => {
      const apply = (current: CoverCropSettings | undefined) => {
        const resolved = { ...clampCoverCrop(current ?? (mode === "gallery" ? fallbackLandscapeCrop : undefined) ?? DEFAULT_COVER_CROP), fit: "cover" as const };
        const value = typeof next === "function" ? next(resolved) : next;
        return value.fit === "contain" ? clampCoverCrop(value)
          : clampCoverCropForAspect(value, sourceAspect ?? getTargetAspect(mode), getTargetAspect(mode));
      };
      if (mode === "cover") setCoverCrop(apply);
      else setLandscapeCoverCrop(apply);
    },
    [mode, sourceAspect, fallbackLandscapeCrop],
  );

  const handlePercentCropChange = useCallback(
    (percentCrop: PercentCrop) => {
      setActiveCrop(
        fromPercentCrop(percentCrop, safeSourceAspect, activeTargetAspect),
      );
    },
    [activeTargetAspect, safeSourceAspect, setActiveCrop],
  );

  const handleZoom = useCallback(
    (value: number) => {
      setActiveCrop((current) => ({
        ...current,
        zoom: value,
      }));
    },
    [setActiveCrop],
  );

  const centerActiveCrop = useCallback(() => {
    setActiveCrop((current) => ({
      ...current,
      x: 0,
      y: 0,
    }));
  }, [setActiveCrop]);

  const resetActiveCrop = useCallback(() => {
    if (mode === "cover") setCoverCrop(undefined);
    else setLandscapeCoverCrop({ ...DEFAULT_COVER_CROP, fit: "cover" });
  }, [mode]);

  const maximizeActiveCrop = useCallback(() => {
    setActiveCrop({ x: 0, y: 0, zoom: 1, fit: "cover" });
  }, [setActiveCrop]);

  const minimizeActiveCrop = useCallback(() => {
    setActiveCrop({ x: 0, y: 0, zoom: MIN_CROP_SIZE, fit: "cover" });
  }, [setActiveCrop]);

  const dialog = (
    <DialogPrimitive.Content onCloseAutoFocus={event => { event.preventDefault(); previousFocus.current?.focus(); }} aria-describedby={undefined} aria-label={t("extra.adjustCoverCrop")} className="fixed inset-0 z-[10000] flex items-stretch justify-center overflow-hidden bg-black/60 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-[calc(env(safe-area-inset-top)+4.25rem)] backdrop-blur-sm md:left-[var(--desktop-sidebar-offset,0px)] md:items-center md:px-4 md:py-4">
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl animate-in fade-in zoom-in-95 duration-200 md:h-auto md:max-h-[calc(100dvh-2rem)]">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3 sm:items-center sm:px-5">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-sm font-semibold text-foreground">{t("extra.adjustCoverCrop")}</DialogPrimitive.Title>
            <p className="mt-0.5 text-xs text-muted-foreground/60 max-sm:hidden">
              {t("extra.crop.hint", "Drag the crop box, then set separate framing for cards and gallery previews.")}
            </p>
          </div>
          <button
            onClick={() => { if (!saving) onCancel(); }} disabled={saving}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={t("common:action.close", "Close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-3 sm:p-4">
          <div className="mb-3 grid grid-cols-2 rounded-lg border border-border bg-card p-1 sm:mb-4 sm:inline-grid sm:w-fit">
            <button
              disabled={saving || !src}
              onClick={() => { if (mode !== "cover") { setSourceAspect(null); setImageFailed(false); setMode("cover"); } }}
              className={`rounded-md px-3 py-2 text-xs font-medium transition-colors sm:py-1.5 ${
                mode === "cover"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("extra.crop.phone")}
            </button>
            <button
              disabled={saving || !landscapeSrc}
              onClick={() => { if (mode !== "gallery") { setSourceAspect(null); setImageFailed(false); setMode("gallery"); } }}
              className={`rounded-md px-3 py-2 text-xs font-medium transition-colors sm:py-1.5 ${
                mode === "gallery"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("extra.crop.desktop")}
            </button>
          </div>

          <div className="flex flex-col gap-4 lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="relative z-0 flex items-start justify-center overflow-hidden lg:min-h-0 lg:items-center">
              <div className="isolate w-full rounded-xl border border-primary/25 bg-card/60 p-3 shadow-inner">
                <div className="relative mx-auto flex w-full max-w-[760px] justify-center overflow-hidden rounded-lg border border-primary/40 bg-black">
                  <ReactCrop
                    crop={wholeImage ? undefined : activePercentCrop}
                    disabled={wholeImage || saving || sourceAspect === null}
                    aspect={activeTargetAspect}
                    keepSelection
                    ruleOfThirds
                    onChange={(_, percentCrop) => handlePercentCropChange(percentCrop)}
                    className="max-h-[48dvh] max-w-full sm:max-h-[56dvh]"
                  >
                    <img
                      key={`${mode}:${activeSrc}`}
                      src={resolveImageUrl(activeSrc)}
                      alt=""
                      draggable={false}
                      className="block max-h-[48dvh] max-w-full select-none sm:max-h-[56dvh]"
                      onError={() => { setSourceAspect(null); setImageFailed(true); }}
                      onLoad={(event) => {
                        const image = event.currentTarget;
                        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                          const nextSourceAspect = image.naturalWidth / image.naturalHeight;
                          setSourceAspect(nextSourceAspect);

                        }
                      }}
                    />
                  </ReactCrop>
                  <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white/85">
                    <Move className="h-3 w-3" />
                    {wholeImage ? t("extra.crop.wholeImage") : t("extra.crop.dragHint", "Drag or resize the crop box")}
                  </div>
                </div>
              </div>
            </div>

            <div className="relative z-0 min-h-0 space-y-4 lg:overflow-y-auto lg:pr-1">
              <p className="text-xs leading-relaxed text-muted-foreground">{t("extra.crop.framingHint")}</p>
              {!wholeImage && <div className="rounded-lg border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">{t("extra.cropSize")}</span>
                  <span className="text-xs text-muted-foreground/60">{Math.round(activeCrop.zoom * 100)}%</span>
                </div>
                <input
                  disabled={saving || sourceAspect === null}
                  type="range"
                  min={MIN_CROP_SIZE}
                  max={MAX_CROP_SIZE}
                  step="0.01"
                  value={activeCrop.zoom}
                  onChange={(event) => handleZoom(Number(event.target.value))}
                  className="w-full accent-primary"
                />
              </div>}

              {!wholeImage && <div className="grid grid-cols-2 gap-2">
                <button
                  disabled={saving || sourceAspect === null}
                  onClick={centerActiveCrop}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <Move className="h-3.5 w-3.5" />
                  {t("extra.crop.center", "Center")}
                </button>
                <button
                  disabled={saving || sourceAspect === null}
                  onClick={maximizeActiveCrop}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  {t("extra.crop.max", "Max")}
                </button>
                <button
                  disabled={saving || sourceAspect === null}
                  onClick={minimizeActiveCrop}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <Minimize2 className="h-3.5 w-3.5" />
                  {t("extra.crop.min", "Min crop box")}
                </button>
                <button
                  disabled={saving || sourceAspect === null}
                  onClick={resetActiveCrop}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("extra.crop.reset", "Reset current view")}
                </button>
              </div>}

              <div className="space-y-3 rounded-lg border border-border bg-card p-3">
                <WorldCoverPreviews placements={placements} details={details} src={src} landscapeSrc={landscapeSrc}
                  coverCrop={mode === "cover" ? activeCrop : coverCrop}
                  landscapeCoverCrop={mode === "gallery" ? activeCrop : landscapeCoverCrop ?? fallbackLandscapeCrop} />
              </div>
            </div>
          </div>
        </div>

        {(error || imageFailed) && <p role="alert" className="px-4 pb-2 text-sm text-destructive">{error || t("extra.crop.imageFailed")}</p>}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-5 sm:py-4">
          <button
            onClick={() => { if (!saving) onCancel(); }} disabled={saving}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            {t("common:action.cancel", "Cancel")}
          </button>
          <button
            disabled={saving || sourceAspect === null || imageFailed}
            onClick={() => onSave({ activeMode: mode, coverCrop: mode === "cover" ? activeCrop : coverCrop, landscapeCoverCrop: mode === "gallery" ? activeCrop : landscapeCoverCrop })}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Check className="h-4 w-4" />
            {saving ? t("common:status.saving", "Saving…") : t("extra.crop.save", "Save crop")}
          </button>
        </div>
      </div>
    </DialogPrimitive.Content>
  );

  return <DialogPrimitive.Root open onOpenChange={open => { if (!open && !saving) onCancel(); }}><DialogPrimitive.Portal>{dialog}</DialogPrimitive.Portal></DialogPrimitive.Root>;
}
