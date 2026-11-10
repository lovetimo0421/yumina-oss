import type { ImgHTMLAttributes } from "react";
import { coverPreviewUrl } from "@/lib/asset-url";

/** Keep the poster's dimensions stable while ReactCrop frames the playing clip. */
export function CoverCropMedia({ playing, ...props }: ImgHTMLAttributes<HTMLImageElement> & { playing: boolean }) {
  const preview = props.src ? coverPreviewUrl(props.src) : undefined;
  return <div className="relative">
    <img {...props} />
    {playing && preview && <video src={`${preview}.mp4`} muted loop autoPlay playsInline preload="metadata"
      aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full object-contain" />}
  </div>;
}
