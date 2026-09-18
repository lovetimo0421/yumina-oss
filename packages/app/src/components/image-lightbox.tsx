import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { useTouchDevice } from "@/hooks/use-touch-device";

export interface PreviewImage {
  src: string;
  alt: string;
}

interface ImageLightboxProps {
  image: PreviewImage | null;
  images?: PreviewImage[];
  index?: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 4;

/**
 * Fullscreen image viewer shared by the community feed and direct messages.
 * Renders through a portal so ancestor stacking/overflow can't clip it.
 *
 * Touch: pinch-to-zoom + double-tap (handled by react-zoom-pan-pinch).
 * Desktop: wheel-zoom + the top-left zoom buttons.
 * A prominent close button sits top-right on every viewport; Escape and the
 * dimmed backdrop also close. Pass `images`/`index`/`onIndexChange` for a
 * multi-image gallery (prev/next nav appears automatically); a lone `image`
 * renders a single-image viewer.
 */
export function ImageLightbox({
  image,
  images,
  index = 0,
  onIndexChange,
  onClose,
}: ImageLightboxProps) {
  const { t } = useTranslation("common");
  const isTouch = useTouchDevice();
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const [scale, setScale] = useState(1);

  const imageList = image ? (images?.length ? images : [image]) : [];
  const activeIndex = Math.min(Math.max(index, 0), Math.max(imageList.length - 1, 0));
  const activeImage = imageList[activeIndex] ?? null;
  const canNavigate = imageList.length > 1;

  // Keep the desktop zoom-button disabled state in sync when the image changes
  // (the TransformWrapper remounts via `key`, resetting to scale 1).
  useEffect(() => {
    setScale(1);
  }, [activeImage?.src]);

  useEffect(() => {
    if (!activeImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft" && canNavigate) {
        event.preventDefault();
        onIndexChange?.((activeIndex - 1 + imageList.length) % imageList.length);
      } else if (event.key === "ArrowRight" && canNavigate) {
        event.preventDefault();
        onIndexChange?.((activeIndex + 1) % imageList.length);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeImage, activeIndex, canNavigate, imageList.length, onClose, onIndexChange]);

  if (!activeImage) return null;

  const goPrevious = () => onIndexChange?.((activeIndex - 1 + imageList.length) % imageList.length);
  const goNext = () => onIndexChange?.((activeIndex + 1) % imageList.length);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] overflow-hidden bg-black/90"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      {/* Prominent, always-visible close button (top-right). */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="absolute z-30 flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/30 backdrop-blur transition hover:bg-black/75 active:scale-95"
        style={{
          top: "max(env(safe-area-inset-top), 0.75rem)",
          right: "max(env(safe-area-inset-right), 0.75rem)",
        }}
        aria-label={t("imageViewer.close")}
        title={t("imageViewer.close")}
      >
        <X className="h-6 w-6" />
      </button>

      {/* Desktop zoom controls — hidden on touch, where pinch + double-tap replace them. */}
      {!isTouch && (
        <div className="absolute left-3 top-3 z-30 flex items-center gap-2 rounded-full border border-white/10 bg-black/55 p-1 shadow-lg backdrop-blur">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              transformRef.current?.zoomOut();
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
            disabled={scale <= MIN_SCALE}
            aria-label={t("imageViewer.zoomOut")}
            title={t("imageViewer.zoomOut")}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              transformRef.current?.resetTransform();
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/10 hover:text-white"
            aria-label={t("imageViewer.resetZoom")}
            title={t("imageViewer.resetZoom")}
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              transformRef.current?.zoomIn();
            }}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
            disabled={scale >= MAX_SCALE}
            aria-label={t("imageViewer.zoomIn")}
            title={t("imageViewer.zoomIn")}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      )}

      {canNavigate && (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              goPrevious();
            }}
            className="absolute left-3 top-1/2 z-30 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/55 text-white/85 shadow-lg backdrop-blur transition-colors hover:bg-white/10 hover:text-white"
            aria-label={t("imageViewer.prevImage")}
            title={t("imageViewer.prevImage")}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              goNext();
            }}
            className="absolute right-3 top-1/2 z-30 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/55 text-white/85 shadow-lg backdrop-blur transition-colors hover:bg-white/10 hover:text-white"
            aria-label={t("imageViewer.nextImage")}
            title={t("imageViewer.nextImage")}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <div className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border border-white/10 bg-black/55 px-3 py-1 text-xs font-semibold text-white/80 shadow-lg backdrop-blur">
            {activeIndex + 1} / {imageList.length}
          </div>
        </>
      )}

      <TransformWrapper
        key={activeImage.src}
        ref={transformRef}
        initialScale={1}
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        centerOnInit
        wheel={{ step: 0.2 }}
        doubleClick={{ mode: "toggle", animationTime: 200 }}
        onTransform={(_ref, state) => setScale(state.scale)}
      >
        <TransformComponent
          wrapperStyle={{ width: "100vw", height: "100vh" }}
          contentStyle={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <img
            src={activeImage.src}
            alt={activeImage.alt}
            className="max-h-[88vh] max-w-[92vw] select-none object-contain"
            draggable={false}
            onClick={(event) => event.stopPropagation()}
            onError={onClose}
          />
        </TransformComponent>
      </TransformWrapper>
    </div>,
    document.body,
  );
}
