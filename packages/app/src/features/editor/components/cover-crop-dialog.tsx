import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { Check, Maximize2, Minimize2, Move, RotateCcw, X } from "lucide-react";
import {
  CroppedImage,
  DEFAULT_COVER_CROP,
  MAX_CROP_SIZE,
  MIN_CROP_SIZE,
  clampCoverCrop,
  clampCoverCropForAspect,
  getCoverCropRect,
  type CoverCropSettings,
} from "@/lib/cover-crop";
import { getWorldGalleryDisplayCrop } from "@/lib/world-cover-crop";

interface CoverCropDialogProps {
  src: string;
  initialCoverCrop?: CoverCropSettings | null;
  initialGalleryCrop?: CoverCropSettings | null;
  onCancel: () => void;
  onSave: (value: {
    coverCrop: CoverCropSettings;
    galleryCoverCrop: CoverCropSettings;
  }) => void;
}

type CropMode = "cover" | "gallery";

function getTargetAspect(mode: CropMode) {
  return mode === "cover" ? 3 / 4 : 16 / 5;
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
  initialCoverCrop,
  initialGalleryCrop,
  onCancel,
  onSave,
}: CoverCropDialogProps) {
  const { t } = useTranslation("editor");
  const [mode, setMode] = useState<CropMode>("cover");
  const [coverCrop, setCoverCrop] = useState<CoverCropSettings>(
    clampCoverCrop(initialCoverCrop ?? DEFAULT_COVER_CROP),
  );
  const [galleryCoverCrop, setGalleryCoverCrop] = useState<CoverCropSettings>(
    getWorldGalleryDisplayCrop(initialGalleryCrop ?? DEFAULT_COVER_CROP),
  );
  const [sourceAspect, setSourceAspect] = useState<number | null>(null);

  const activeCrop = mode === "cover" ? coverCrop : galleryCoverCrop;
  const activeTargetAspect = getTargetAspect(mode);
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
      const apply = (current: CoverCropSettings) =>
        clampCoverCropForAspect(
          typeof next === "function" ? next(current) : next,
          sourceAspect ?? getTargetAspect(mode),
          getTargetAspect(mode),
        );
      if (mode === "cover") {
        setCoverCrop(apply);
      } else {
        setGalleryCoverCrop((current) => getWorldGalleryDisplayCrop(apply(current)));
      }
    },
    [mode, sourceAspect],
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
    setActiveCrop(mode === "gallery" ? getWorldGalleryDisplayCrop(DEFAULT_COVER_CROP) : DEFAULT_COVER_CROP);
  }, [mode, setActiveCrop]);

  const maximizeActiveCrop = useCallback(() => {
    setActiveCrop({ x: 0, y: 0, zoom: 1, fit: "cover" });
  }, [setActiveCrop]);

  const minimizeActiveCrop = useCallback(() => {
    setActiveCrop({ x: 0, y: 0, zoom: MIN_CROP_SIZE, fit: "cover" });
  }, [setActiveCrop]);

  const dialog = (
    <div className="fixed inset-0 z-[10000] flex items-stretch justify-center overflow-hidden bg-black/60 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-[calc(env(safe-area-inset-top)+4.25rem)] backdrop-blur-sm md:left-[var(--desktop-sidebar-offset,0px)] md:items-center md:px-4 md:py-4">
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl animate-in fade-in zoom-in-95 duration-200 md:h-auto md:max-h-[calc(100dvh-2rem)]">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3 sm:items-center sm:px-5">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{t("extra.adjustCoverCrop")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground/60 max-sm:hidden">
              Drag the crop box, then set separate framing for cards and gallery previews.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-3 sm:p-4">
          <div className="mb-3 grid grid-cols-2 rounded-lg border border-border bg-card p-1 sm:mb-4 sm:inline-grid sm:w-fit">
            <button
              onClick={() => setMode("cover")}
              className={`rounded-md px-3 py-2 text-xs font-medium transition-colors sm:py-1.5 ${
                mode === "cover"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Card cover
            </button>
            <button
              onClick={() => setMode("gallery")}
              className={`rounded-md px-3 py-2 text-xs font-medium transition-colors sm:py-1.5 ${
                mode === "gallery"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Gallery preview
            </button>
          </div>

          <div className="flex flex-col gap-4 lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="relative z-0 flex items-start justify-center overflow-hidden lg:min-h-0 lg:items-center">
              <div className="isolate w-full rounded-xl border border-primary/25 bg-card/60 p-3 shadow-inner">
                <div className="relative mx-auto flex w-full max-w-[760px] justify-center overflow-hidden rounded-lg border border-primary/40 bg-black">
                  <ReactCrop
                    crop={activePercentCrop}
                    aspect={activeTargetAspect}
                    keepSelection
                    ruleOfThirds
                    onChange={(_, percentCrop) => handlePercentCropChange(percentCrop)}
                    className="max-h-[48dvh] max-w-full sm:max-h-[56dvh]"
                  >
                    <img
                      src={src}
                      alt=""
                      draggable={false}
                      className="block max-h-[48dvh] max-w-full select-none sm:max-h-[56dvh]"
                      onLoad={(event) => {
                        const image = event.currentTarget;
                        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                          const nextSourceAspect = image.naturalWidth / image.naturalHeight;
                          setSourceAspect(nextSourceAspect);
                          setCoverCrop((current) =>
                            clampCoverCropForAspect(current, nextSourceAspect, getTargetAspect("cover")),
                          );
                          setGalleryCoverCrop((current) =>
                            getWorldGalleryDisplayCrop(
                              clampCoverCropForAspect(current, nextSourceAspect, getTargetAspect("gallery")),
                            ),
                          );
                        }
                      }}
                    />
                  </ReactCrop>
                  <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white/85">
                    <Move className="h-3 w-3" />
                    Drag or resize the crop box
                  </div>
                </div>
              </div>
            </div>

            <div className="relative z-0 min-h-0 space-y-4 lg:overflow-y-auto lg:pr-1">
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">{t("extra.cropSize")}</span>
                  <span className="text-xs text-muted-foreground/60">{Math.round(activeCrop.zoom * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={MIN_CROP_SIZE}
                  max={MAX_CROP_SIZE}
                  step="0.01"
                  value={activeCrop.zoom}
                  onChange={(event) => handleZoom(Number(event.target.value))}
                  className="w-full accent-primary"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={centerActiveCrop}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <Move className="h-3.5 w-3.5" />
                  Center
                </button>
                <button
                  onClick={maximizeActiveCrop}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  Max
                </button>
                <button
                  onClick={minimizeActiveCrop}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <Minimize2 className="h-3.5 w-3.5" />
                  Min crop box
                </button>
                <button
                  onClick={resetActiveCrop}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset current view
                </button>
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-card p-3">
                <div>
                  <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t("extra.cardCover")}</p>
                  <CroppedImage src={src} alt="" crop={coverCrop} className="mx-auto aspect-[3/4] w-20 rounded-md border border-border" />
                </div>
                <div>
                  <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t("extra.galleryPreview")}</p>
                  <CroppedImage src={src} alt="" crop={galleryCoverCrop} className="aspect-[16/5] w-full rounded-md border border-border" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-5 sm:py-4">
          <button
            onClick={onCancel}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave({ coverCrop: clampCoverCrop(coverCrop), galleryCoverCrop: getWorldGalleryDisplayCrop(galleryCoverCrop) })}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Check className="h-4 w-4" />
            Save crop
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
