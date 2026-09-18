import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Recipe R2: the trigger shows a check for `resetMs` instead of a toast.
 * Usage: const { copied, copy } = useCopyFeedback();
 *        <button onClick={() => copy(url)}>{copied ? <Check/> : <Copy/>}</button>
 */
export function useCopyFeedback(resetMs = 1200) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), resetMs);
      return true;
    },
    [resetMs],
  );
  return { copied, copy };
}
