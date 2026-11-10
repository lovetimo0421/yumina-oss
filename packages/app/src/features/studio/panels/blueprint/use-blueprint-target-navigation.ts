import { useEffect, useRef } from "react";

export interface BlueprintTargetRequest {
  objectId: string;
  documentKey: string;
  sequence: number;
}

export interface BlueprintTargetBounds { x: number; y: number; width: number; height: number }

/** Opening a collapsed module registers its children asynchronously. Do not
 * center guessed coordinates while the requested block is still absent. */
export function waitForMeasuredBlueprintTarget({ getTarget, isCurrent, onReady }: {
  getTarget: () => BlueprintTargetBounds | undefined;
  isCurrent: () => boolean;
  onReady: (bounds: BlueprintTargetBounds) => void;
}): () => void {
  let frame = 0;
  let cancelled = false;
  const deadline = performance.now() + 1500;
  const attempt = () => {
    if (cancelled || !isCurrent()) return;
    const target = getTarget();
    if (target && target.width > 0 && target.height > 0) { onReady(target); return; }
    if (performance.now() < deadline) frame = requestAnimationFrame(attempt);
  };
  attempt();
  return () => { cancelled = true; cancelAnimationFrame(frame); };
}

/** A global-blueprint handoff waits for the pane and its initial viewport.
 * Switching back or opening another card cancels it without moving that card. */
export function useBlueprintTargetNavigation({ request, documentKey, active, viewportReady, isViewportSettled, navigate, onComplete }: {
  request: BlueprintTargetRequest | null;
  documentKey: string;
  active: boolean;
  viewportReady: boolean;
  isViewportSettled: () => boolean;
  navigate: (objectId: string) => void;
  onComplete: (request: BlueprintTargetRequest) => void;
}) {
  const callbacks = useRef({ navigate, onComplete });
  callbacks.current = { navigate, onComplete };
  useEffect(() => {
    if (!active || !viewportReady || !request || request.documentKey !== documentKey) return;
    let frame = 0;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      if (!isViewportSettled()) { frame = requestAnimationFrame(attempt); return; }
      callbacks.current.navigate(request.objectId);
      callbacks.current.onComplete(request);
    };
    frame = requestAnimationFrame(attempt);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [request, documentKey, active, viewportReady, isViewportSettled]);
}
