import { useEffect, useState } from "react";
import type { SandboxedYuminaAPI } from "../sandbox-context";

export interface TurnImageSettings {
  available: boolean;
  auto: boolean;
  /** Mushies per picture once the free ones are used. */
  price?: number;
  freeLeft?: number;
  unlimited?: boolean;
  /** Whether a fine (full-schedule) redraw is offered. */
  fine?: boolean;
}

// One fetch per sandbox; every message's action row and the composer menu
// read the same value, so flipping the switch updates them all at once.
let cached: TurnImageSettings | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<(s: TurnImageSettings | null) => void>();

function publish(next: TurnImageSettings | null) {
  cached = next;
  listeners.forEach((fn) => fn(next));
}

export function useTurnImageSettings(api: SandboxedYuminaAPI) {
  const [settings, setSettings] = useState(cached);
  useEffect(() => {
    listeners.add(setSettings);
    if (!cached && !loading) {
      loading = api.getTurnImageSettings().then(publish, () => {}).finally(() => { loading = null; });
    }
    return () => { listeners.delete(setSettings); };
  }, [api]);

  const setAuto = async (on: boolean) => {
    const previous = cached;
    if (previous) publish({ ...previous, auto: on });
    const ok = await api.setAutoTurnImages(on);
    if (!ok && previous) publish(previous);
    return ok;
  };

  // The free count goes down with every picture: re-read when the menu opens.
  const refresh = () => { void api.getTurnImageSettings().then((s) => { if (s) publish(s); }, () => {}); };

  return { settings, setAuto, refresh };
}
