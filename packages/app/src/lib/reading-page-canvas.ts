import { getMobileReadingPageId } from "./mobile-reading-route";

interface ReadingPageCanvas {
  imageUrl: string;
  opacity: number;
  gradient: string;
}

/** Only the pre-React bootstrap needs redirect cleanup. Once AppShell adopts
 * it, its viewport controller owns reading mode and transfers scroll positions. */
export function clearReadingPageBootstrap(document: Document, pathname: string): void {
  const root = document.documentElement;
  if (!/^\/app\/messages(?:\/|$)/.test(pathname)) root.removeAttribute("data-mobile-message-canvas");
  if (!root.hasAttribute("data-reading-boot")) return;
  if (getMobileReadingPageId(pathname)) return;
  root.removeAttribute("data-reading-boot");
  root.removeAttribute("data-mobile-page-scroll");
}

/** Paint the actual document canvas, including the area beneath browser chrome.
 * Fixed wallpaper elements can be clipped above Safari's keyboard/toolbars.
 * These variables are consumed only while data-mobile-page-scroll is present.
 */
export function installReadingPageCanvas(document: Document, canvas: ReadingPageCanvas): () => void {
  const style = document.documentElement.style;
  const opacity = Number.isFinite(canvas.opacity) ? Math.min(1, Math.max(0, canvas.opacity)) : 1;
  const veil = `rgba(11, 10, 16, ${(1 - opacity).toFixed(3)})`;
  const image = JSON.stringify(canvas.imageUrl.replace(/[\n\r\f]/g, ""));
  // Navigation/edge color belongs to the shared critical stylesheet. Wallpaper
  // brightness must not change it between routes or during startup hydration.
  const properties = {
    "--reading-canvas-image": `url(${image})`,
    "--reading-canvas-veil": `linear-gradient(${veil}, ${veil})`,
    "--reading-canvas-gradient": canvas.gradient,
    "--reading-canvas-aspect": "1.7777778",
  };
  const previous = Object.keys(properties).map((name) => [name, style.getPropertyValue(name), style.getPropertyPriority(name)]);
  for (const [name, value] of Object.entries(properties)) style.setProperty(name, value);
  // Preserve custom portrait/landscape art without tying cover sizing to the
  // growing document. No viewport listeners or scroll/layout writes are needed.
  const probe = document.defaultView ? new document.defaultView.Image() : null;
  let disposed = false;
  const updateAspect = () => {
    if (!disposed && probe && probe.naturalWidth > 0 && probe.naturalHeight > 0) {
      style.setProperty("--reading-canvas-aspect", String(probe.naturalWidth / probe.naturalHeight));
    }
  };
  if (probe) {
    probe.onload = updateAspect;
    probe.src = canvas.imageUrl;
    if (probe.complete) updateAspect();
  }
  return () => {
    disposed = true;
    if (probe) probe.onload = null;
    for (const [name, value, priority] of previous) {
      if (value) style.setProperty(name!, value, priority);
      else style.removeProperty(name!);
    }
  };
}
