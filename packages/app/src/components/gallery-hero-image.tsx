import type { ImgHTMLAttributes } from "react";
import {
  CroppedImage,
  type CoverCropSettings,
} from "@/lib/cover-crop";
import { HEAD_SAFE_GALLERY_HERO_CROP } from "@/lib/world-cover-crop";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";

const BACKDROP_IMAGE_WIDTH = 640;
const WIDE_DESKTOP_QUERY = "(min-width: 1920px)";

interface GalleryHeroImageProps {
  src: string;
  alt: string;
  crop?: CoverCropSettings | null;
  className?: string;
  width?: number;
  fetchPriority?: ImgHTMLAttributes<HTMLImageElement>["fetchPriority"];
  coverOnStandardDesktop?: boolean;
}

/**
 * Uses the creator's crop at every display width. The contained backdrop is a
 * defensive fallback for callers that do not provide crop data.
 */
export function GalleryHeroImage({
  src,
  alt,
  crop,
  className,
  width,
  fetchPriority,
  coverOnStandardDesktop = false,
}: GalleryHeroImageProps) {
  const isWideDesktop = useMediaQuery(WIDE_DESKTOP_QUERY);
  const hasCreatorCrop = crop != null;

  if (hasCreatorCrop || (coverOnStandardDesktop && !isWideDesktop)) {
    return (
      <CroppedImage
        src={src}
        alt={alt}
        crop={crop}
        width={width}
        fetchPriority={fetchPriority}
        loading={fetchPriority === "high" ? "eager" : "lazy"}
        className={cn("bg-[#202024]", className)}
      />
    );
  }

  return (
    <div className={cn("relative isolate overflow-hidden bg-[#202024]", className)}>
      <CroppedImage
        aria-hidden="true"
        src={src}
        alt=""
        crop={crop}
        width={BACKDROP_IMAGE_WIDTH}
        className="pointer-events-none absolute inset-0 h-full w-full scale-105 brightness-[0.82] saturate-125 blur-lg"
      />
      <CroppedImage
        src={src}
        alt={alt}
        crop={HEAD_SAFE_GALLERY_HERO_CROP}
        width={width}
        fetchPriority={fetchPriority}
        loading={fetchPriority === "high" ? "eager" : "lazy"}
        className="absolute inset-0 h-full w-full"
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-black/5" />
    </div>
  );
}
