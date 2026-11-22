import { useLayoutEffect, useRef, useState } from "react";

/** Fit ReactCrop's image to the actual space left by the dialog controls. */
export function useCropViewport(sourceAspect: number | null) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [mediaWidth, setMediaWidth] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setMediaWidth(Math.min(
      viewport.clientWidth,
      viewport.clientHeight * (sourceAspect ?? 1),
    ));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [sourceAspect]);

  return { viewportRef, mediaWidth };
}
