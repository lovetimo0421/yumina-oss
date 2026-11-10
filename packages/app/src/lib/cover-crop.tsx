import { useEffect, useMemo, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { resolveImageUrl, originalImageUrl, cardImageUrl, isAnimatedImageRef, isMotionCoverRef, coverPreviewUrl } from "./asset-url";
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
  /** Fill unused space behind contained artwork with a soft copy of the same image. */
  ambientBackdrop?: boolean;
  /** Target CSS display width. When set, the image is fetched through the CF
   *  resizer at this width (plus a 2x variant via srcset for retina) instead of
   *  full resolution — turns multi-MB originals into ~30-80KB. Omit for
   *  must-be-full-res images (e.g. a lightbox). */
  width?: number;
  motion?: boolean;
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
  ambientBackdrop = false,
  motion = true,
  style,
  ...imgProps
}: CroppedImageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sourceAspect, setSourceAspect] = useState<number | null>(null);
  const [targetAspect, setTargetAspect] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  // When a /cdn-cgi/image/ transform URL 404s (transformations toggled off),
  // fall back to the untransformed original instead of a broken cover.
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => {
    setFallbackSrc(null);
    setPosterFailed(false);
  }, [src]);
  // An animated cover paints its first frame first (a ~20KB still), and the
  // animation is layered on top once the card is on screen. Before this the
  // slot stayed dark until a multi-MB GIF had fully downloaded.
  const managedMotion = isMotionCoverRef(src);
  const previewUrl = width || managedMotion ? coverPreviewUrl(src) : undefined;
  const animated = (!!width || managedMotion) && (!fallbackSrc || managedMotion) && (!!previewUrl || isAnimatedImageRef(src));
  // Size through the CF resizer when a display width is given; on a transform
  // 404 the onError handler swaps to the untransformed original (see below).
  const posterUrl = (pixels: number) => {
    const url = cardImageUrl(src, pixels, { still: animated });
    return previewUrl ? url?.replace(",onerror=redirect", "") : url;
  };
  const sized = width ? posterUrl(width) : undefined;
  const resolvedSrc = fallbackSrc ?? sized ?? resolveImageUrl(src) ?? src;
  const srcSet = !fallbackSrc && width && sized
    ? `${sized} 1x, ${posterUrl(width * 2) ?? sized} 2x`
    : undefined;
  const [inView, setInView] = useState(false);
  const [motionLoaded, setMotionLoaded] = useState(false);
  const [motionFailed, setMotionFailed] = useState(false);
  const [preview, setPreview] = useState<{ url: string; kind: string } | null>(null);
  useEffect(() => {
    setMotionLoaded(false);
    setMotionFailed(false);
    setPreview(null);
    setInView(false);
  }, [src]);
  useEffect(() => {
    const element = containerRef.current;
    if (!motion) { setInView(false); return; }
    if (!animated || !element) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setInView(entries.some((e) => e.isIntersecting));
    }, { rootMargin: "0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [animated, src, motion]);
  useEffect(() => {
    if (!previewUrl || !inView) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const inspect = async () => {
      try {
        const response = await fetch(previewUrl, { signal: controller.signal });
        if (!response.ok) return;
        const result = await response.json() as { kind?: string };
        if (controller.signal.aborted) return;
        setPreview({ url: previewUrl, kind: result.kind ?? "still" });
        if (result.kind === "pending" && ++attempts < 18) timer = setTimeout(inspect, 5000);
      } catch { /* The first frame stays visible; never load an unchecked master. */ }
    };
    void inspect();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [previewUrl, inView]);
  const managedKind = preview?.url === previewUrl ? preview?.kind : undefined;
  useEffect(() => {
    if (posterFailed && managedKind === "static") setFallbackSrc(resolveImageUrl(src) ?? src);
  }, [posterFailed, managedKind, src]);
  const motionSrc = animated && inView && !motionFailed && (!previewUrl || managedKind === "original") ? cardImageUrl(src, width) : undefined;
  const videoSrc = previewUrl && managedKind === "video" && !motionFailed ? `${previewUrl}.mp4` : undefined;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (inView) void video.play().catch(() => {});
    else video.pause();
  }, [inView, videoSrc]);
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
      {ambientBackdrop && loaded && (Number.parseFloat(String(imageLayoutStyle.width)) < 99.9 || Number.parseFloat(String(imageLayoutStyle.height)) < 99.9) && (
        <img aria-hidden="true" alt="" src={resolvedSrc} srcSet={srcSet}
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-xl"
          decoding="async" />
      )}
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
          setPosterFailed(true);
          const original = originalImageUrl(resolvedSrc);
          if ((!previewUrl || managedMotion) && original !== resolvedSrc) {
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
      {videoSrc && inView && (
        <video key={videoSrc} ref={videoRef} src={videoSrc} muted loop autoPlay playsInline
          preload="metadata" aria-hidden="true"
          className={cn("pointer-events-none absolute max-w-none select-none transition-opacity duration-500", motionLoaded ? "opacity-100" : "opacity-0", imgClassName)}
          style={imageLayoutStyle}
          onLoadedData={() => setMotionLoaded(true)}
          onError={() => setMotionFailed(true)} />
      )}
      {overlay}
    </div>
  );
}
