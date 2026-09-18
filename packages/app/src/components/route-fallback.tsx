import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

/**
 * Suspense fallback for lazily-loaded routes. Renders nothing for a short grace
 * period so fast (cached) chunk loads don't flash a spinner, then shows a
 * centered spinner so slow connections get feedback instead of a blank content
 * area. Mirrors PersistentChat's LoadingSpinner so play/library/hub feel
 * consistent on a weak connection.
 */
export function RouteFallback({ delayMs = 250 }: { delayMs?: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  if (!show) return null;

  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
    </div>
  );
}
