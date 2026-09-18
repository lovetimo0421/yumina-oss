import { useEffect, useRef, useState } from "react";

/**
 * Recipe R3: true for `ms` after `trigger` becomes truthy. Drive a "Saved" label:
 *   const justSaved = useTransientFlag(savedAt, 1500);
 *   {saving ? "Saving…" : justSaved ? "Saved" : null}
 * Pass a value that CHANGES on each save (a timestamp), not a boolean that stays true.
 */
export function useTransientFlag(trigger: unknown, ms = 1500): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!trigger) return;
    setOn(true);
    const id = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(id);
  }, [trigger, ms]);
  return on;
}
