import { useCallback, useEffect, useRef } from "react";

type Viewport = { x: number; y: number; zoom: number };

/** Delayed layout/resize fits must yield to an object the author is visiting.
 * Read the current intent when a timer fires, not when it was scheduled. */
export function useAutomaticBlueprintFit({ blocked, fit }: {
  blocked: boolean;
  fit: (duration?: number) => unknown;
}) {
  const current = useRef({ blocked, fit });
  current.current = { blocked, fit };
  return useCallback((duration = 0) => {
    if (!current.current.blocked) return current.current.fit(duration);
  }, []);
}

/** ReactFlow is unmounted in content view. Measure its first appearance, then
 * restore the author's position when they return instead of fitting again. */
export function useInitialBlueprintFit({ writing, worldId, ready, viewportReady, nodeCount, getNodes, getViewport, setViewport, fit }: {
  writing: boolean;
  worldId: string;
  ready: boolean;
  viewportReady: boolean;
  nodeCount: number;
  getNodes: () => { measured?: { height?: number } }[];
  getViewport: () => Viewport;
  setViewport: (viewport: Viewport) => unknown;
  fit: () => unknown;
}) {
  const fitted = useRef<string | null>(null);
  const cancelledFor = useRef<string | null>(null);
  const cancelInitialFit = useCallback(() => {
    cancelledFor.current = worldId;
    fitted.current = worldId;
  }, [worldId]);
  const viewports = useRef(new Map<string, Viewport>());
  // Call from the view switch before ReactFlow's unmount resets its store.
  const rememberViewport = useCallback(() => {
    // Other fits and manual pan/zoom can establish a viewport before every
    // controlled node has measurements. Their position is still authoritative.
    if (writing || !viewportReady) return;
    const viewport = getViewport();
    if (![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom <= 0) return;
    viewports.current.set(worldId, { ...viewport });
  }, [getViewport, worldId, writing, viewportReady]);
  useEffect(() => {
    if (cancelledFor.current !== worldId) cancelledFor.current = null;
    if (writing) { fitted.current = null; cancelledFor.current = null; return; }
    if (!viewportReady || fitted.current === worldId) return;
    const previous = viewports.current.get(worldId);
    if (!previous && (!ready || !nodeCount)) return;
    let frame = 0;
    let cancelled = false;
    const deadline = performance.now() + 900;
    const retry = () => {
      if (cancelled || cancelledFor.current === worldId) return;
      if (performance.now() < deadline) frame = requestAnimationFrame(attempt);
      // Complex previews may still be measuring. Use the available frame
      // bounds once instead of leaving the author at ReactFlow's default
      // viewport. Explicit navigation must not remain blocked after this.
      else Promise.resolve(previous ? setViewport(previous) : fit()).catch(() => {}).finally(() => {
        if (!cancelled) fitted.current = worldId;
      });
    };
    const attempt = () => {
      if (cancelled || cancelledFor.current === worldId) return;
      if (previous) {
        // Restoring coordinates needs the pan/zoom pane, not node sizes.
        // setViewport returns false if that pane was reset during mounting.
        Promise.resolve(setViewport(previous)).then(applied => {
          if (cancelled) return;
          if (applied === false) retry();
          else fitted.current = worldId;
        }).catch(retry);
        return;
      }
      const nodes = getNodes();
      if (nodes.length < nodeCount || nodes.some(node => !(node.measured?.height && node.measured.height > 0))) {
        retry();
        return;
      }
      Promise.resolve(fit()).then(applied => {
        if (cancelled) return;
        if (applied === false) retry();
        else fitted.current = worldId;
      }).catch(retry);
    };
    frame = requestAnimationFrame(attempt);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [writing, worldId, ready, viewportReady, nodeCount, getNodes, setViewport, fit]);
  const isViewportSettled = useCallback(() => fitted.current === worldId, [worldId]);
  return { rememberViewport, isViewportSettled, cancelInitialFit };
}
