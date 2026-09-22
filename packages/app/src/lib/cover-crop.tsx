import { useEffect, useMemo, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { resolveImageUrl, originalImageUrl, cardImageUrl, isAnimatedImageRef } from "./asset-url";
import {
  defaultCropImageRenderer,
  type CoverCropSettings,
  type CropImageRenderer,
} from "./cropping";
import { cn } from "./utils";

export {
  clampCoverCrop,
  clampCoverCropForAspect,
  coverCropImageLayoutStyle,
  coverCropImageStyle,
  DEFAULT_COVER_CROP,
  defaultCropImageRenderer,
  DefaultCropImageRenderer,
  getCoverCropRect,
  MAX_CROP_SIZE,
  MIN_CROP_SIZE,
  normalizeCoverCrop,
  type CoverCropSettings,
  type CropImageRenderer,
  type CropImageRenderInput,
  type CropRect,
} from "./cropping";

interface CroppedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> {
  src: string;
  alt: string;
  crop?: CoverCropSettings | null;
  className?: string;
  imgClassName?: string;
  overlay?: ReactNode;
  renderer?: CropImageRenderer;
  /** Show a shimmer placeholder behind the image until it loads (covers,
   *  grids). Off by default so avatars/inline uses stay unaffected. */
  placeholder?: boolean;
  /** Target CSS display width. When set, the image is fetched through the CF
   *  resizer at this width (plus a 2x variant via srcset for retina) instead of
   *  full resolution — turns multi-MB originals into ~30-80KB. Omit for
   *  must-be-full-res images (e.g. a lightbox). */
  width?: number;
}

export function CroppedImage({
  src,
  alt,
  crop,
  width,
  className,
  imgClassName,
  overlay,
  renderer = defaultCropImageRenderer,
  placeholder = false,
  style,
  ...imgProps
}: CroppedImageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [sourceAspect, setSourceAspect] = useState<number | null>(null);
  const [targetAspect, setTargetAspect] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  // When a /cdn-cgi/image/ transform URL 404s (transformations toggled off),
  // fall back to the untransformed original instead of a broken cover.
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  useEffect(() => {
    setFallbackSrc(null);
  }, [src]);
  // An animated cover paints its first frame first (a ~20KB still), and the
  // animation is layered on top once the card is on screen. Before this the
  // slot stayed dark until a multi-MB GIF had fully downloaded.
  const animated = !!width && !fallbackSrc && isAnimatedImageRef(src);
  // Size through the CF resizer when a display width is given; on a transform
  // 404 the onError handler swaps to the untransformed original (see below).
  const sized = width ? cardImageUrl(src, width, { still: animated }) : undefined;
  const resolvedSrc = fallbackSrc ?? sized ?? resolveImageUrl(src) ?? src;
  const srcSet = !fallbackSrc && width && sized
    ? `${sized} 1x, ${cardImageUrl(src, width * 2, { still: animated }) ?? sized} 2x`
    : undefined;
  const [inView, setInView] = useState(false);
  const [motionLoaded, setMotionLoaded] = useState(false);
  const [motionFailed, setMotionFailed] = useState(false);
  useEffect(() => {
    setMotionLoaded(false);
    setMotionFailed(false);
  }, [src]);
  useEffect(() => {
    const element = containerRef.current;
    if (!animated || !element || inView) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setInView(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [animated, inView]);
  const motionSrc = animated && inView && !motionFailed ? cardImageUrl(src, width) : undefined;
  const imageLayoutStyle = useMemo(
    () => renderer.getImageStyle({ crop, sourceAspect, targetAspect }),
    [crop, renderer, sourceAspect, targetAspect],
  );

  useEffect(() => {
    // A cached image can finish loading before React attaches `onLoad`, so the
    // handler never fires and `loaded` would stay false. Reconcile against the
    // already-complete state here instead of trusting `onLoad` alone.
    const image = imgRef.current;
    if (image && image.complete && image.naturalWidth > 0) {
      setSourceAspect(image.naturalWidth / image.naturalHeight);
      setLoaded(true);
    } else {
      setLoaded(false);
    }
  }, [resolvedSrc]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateTargetAspect = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // Quantized to 2dp: sub-pixel resize chatter produces an identical
        // value, and React bails out of re-rendering on Object.is-equal state.
        // A 0.01 aspect step is far below anything visible in crop placement.
        setTargetAspect(Math.round((rect.width / rect.height) * 100) / 100);
      }
    };

    updateTargetAspect();
    let raf = 0;
    const observer = new ResizeObserver(() => {
      // Coalesce resize bursts (window drag, sidebar animation): one
      // measurement per frame instead of one re-render per resize event,
      // across every mounted card at once.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateTargetAspect);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("relative overflow-hidden", className)}
      style={style}
    >
      {placeholder && (
        <div
          aria-hidden="true"
          className={cn(
            "skeleton-shimmer pointer-events-none absolute inset-0 bg-white/[0.03] transition-opacity duration-500",
            loaded ? "opacity-0" : "opacity-100",
          )}
        />
      )}
      <img
        {...imgProps}
        ref={imgRef}
        src={resolvedSrc}
        srcSet={srcSet}
        loading={imgProps.loading ?? "lazy"}
        decoding={imgProps.decoding ?? "async"}
        alt={alt}
        className={cn(
          "pointer-events-none absolute max-w-none select-none transition-opacity duration-300",
          loaded ? "opacity-100" : "opacity-0",
          imgClassName,
        )}
        style={imageLayoutStyle}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            setSourceAspect(image.naturalWidth / image.naturalHeight);
          }
          setLoaded(true);
          imgProps.onLoad?.(event);
        }}
        onError={(event) => {
          const original = originalImageUrl(resolvedSrc);
          if (original !== resolvedSrc) {
            // Transform endpoint unavailable — retry with the original image.
            setFallbackSrc(original);
            return;
          }
          // Never strand the cover on a failed load: reveal so a broken image
          // shows instead of leaving the slot blank.
          setLoaded(true);
          imgProps.onError?.(event);
        }}
      />
      {motionSrc && (
        <img
          aria-hidden="true"
          alt=""
          src={motionSrc}
          decoding="async"
          className={cn(
            "pointer-events-none absolute max-w-none select-none transition-opacity duration-500",
            motionLoaded ? "opacity-100" : "opacity-0",
            imgClassName,
          )}
          style={imageLayoutStyle}
          onLoad={() => setMotionLoaded(true)}
          // The still underneath stays; a failed animation just never fades in.
          onError={() => setMotionFailed(true)}
        />
      )}
      {overlay}
    </div>
  );
}
