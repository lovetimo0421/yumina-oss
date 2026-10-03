import { Bookmark, Clock3, ImageIcon, Sparkles, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CroppedImage, type CoverCropSettings } from "@/lib/cover-crop";
import { discoveryCoverImageRenderer, DISCOVER_COVER_ASPECTS } from "@/lib/discover-world-artwork";
import "./world-cover-previews.css";

export interface CoverPreviewDetails {
  title?: string;
  description?: string;
  creatorName?: string | null;
  creatorImage?: string | null;
}

export interface CoverPlacementPreview {
  label: string;
  shape: "portrait" | "landscape";
  aspectRatio: number;
}

/** Image frames and crop math match public cards; overlays reveal occupied space.
 * Presentation only: no nested actions, fake statistics, or hosted dependencies. */
export function WorldCoverPreview({ src, crop, shape, details = {} }: {
  src?: string | null;
  crop?: CoverCropSettings | null;
  shape: "portrait" | "landscape";
  details?: CoverPreviewDetails;
}) {
  const { t } = useTranslation("coverEditor");
  return <div className="cover-preview-card" data-shape={shape}>
    <div className="cover-preview-image" style={{ aspectRatio: shape === "portrait" ? DISCOVER_COVER_ASPECTS.cover : DISCOVER_COVER_ASPECTS.gallery }}>
      {src ? <CroppedImage src={src} alt="" crop={crop} renderer={discoveryCoverImageRenderer}
        width={540} className="absolute inset-0 h-full w-full" /> : <ImageIcon className="m-auto opacity-30" />}
    </div>
    {shape === "portrait" && <Bookmark className="cover-preview-bookmark" aria-hidden="true" size={17} />}
    <div className="cover-preview-copy">
      <div className="cover-preview-title"><strong>{details.title || t("extra.crop.previewTitle")}</strong>{shape === "landscape" && <Bookmark aria-hidden="true" size={16} />}</div>
      {shape === "landscape" && <p>{details.description || t("extra.crop.previewDescription")}</p>}
      <div className="cover-preview-footer">
        <span className="cover-preview-creator">{details.creatorImage ? <img src={details.creatorImage} alt="" /> : <UserRound aria-hidden="true" size={16} />}<span>{details.creatorName || t("extra.crop.previewCreator")}</span></span>
        <span className="cover-preview-stats" aria-label={t("extra.crop.previewStats")}><Sparkles size={12} /> — <Clock3 size={12} /> —</span>
      </div>
    </div>
  </div>;
}

export function WorldCoverPreviews({ src, landscapeSrc, coverCrop, landscapeCoverCrop, details, placements = [] }: {
  src?: string | null;
  landscapeSrc?: string | null;
  coverCrop?: CoverCropSettings | null;
  landscapeCoverCrop?: CoverCropSettings | null;
  details?: CoverPreviewDetails;
  placements?: CoverPlacementPreview[];
}) {
  const { t } = useTranslation("coverEditor");
  return <div className="space-y-4" data-cover-previews>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("extra.crop.previewHint")}</p>
    <div>
      <p className="mb-2 text-[11px] font-medium text-muted-foreground">{t("extra.crop.phone")}</p>
      <div className="max-w-[190px]"><WorldCoverPreview src={src} crop={coverCrop} shape="portrait" details={details} /></div>
    </div>
    <div>
      <p className="mb-2 text-[11px] font-medium text-muted-foreground">{t("extra.crop.desktop")}</p>
      {landscapeSrc ? <WorldCoverPreview src={landscapeSrc} crop={landscapeCoverCrop} shape="landscape" details={details} />
        : <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-border bg-muted/10 px-3 text-center text-xs text-muted-foreground">{t("overview.landscapeNeeded")}</div>}
    </div>
    {placements.map(placement => <div key={placement.label}>
      <p className="mb-2 text-[11px] font-medium text-muted-foreground">{placement.label}</p>
      <div className="relative overflow-hidden rounded-lg bg-[#24212a]" style={{ aspectRatio: placement.aspectRatio }}>
        <CroppedImage src={(placement.shape === "portrait" ? src : landscapeSrc || src) ?? ""} alt=""
          crop={placement.shape === "portrait" ? coverCrop : landscapeCoverCrop} renderer={discoveryCoverImageRenderer}
          className="absolute inset-0 h-full w-full" width={540} />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#10121ceb] to-transparent px-3 pb-3 pt-12">
          <p className="line-clamp-2 text-sm font-medium text-white">{details?.title || t("extra.crop.previewTitle")}</p>
          <p className="mt-1 truncate text-[11px] text-white/70">{details?.creatorName || t("extra.crop.previewCreator")}</p>
        </div>
      </div>
    </div>)}
  </div>;
}
