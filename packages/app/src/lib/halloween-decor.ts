import { create } from "zustand";

/**
 * Halloween dress-up for the app shell (the mushie gets a pumpkin face, the
 * logo a witch hat, one bat crosses the top bar per visit). Cards' own screens
 * are never touched — those belong to their creators.
 *
 * The window defaults to the event's reward days (Oct 31 04:00 to Nov 3 04:00,
 * Asia/Shanghai). The hosted event endpoint reports the server's window, so a
 * testing deploy that moves the event moves the decorations with it.
 */
const DEFAULT_WINDOW = { startsAt: Date.parse("2026-10-30T20:00:00Z"), endsAt: Date.parse("2026-11-02T20:00:00Z") };
const OFF_KEY = "yumina:halloween-decor-off";

function readOff(): boolean {
  try { return localStorage.getItem(OFF_KEY) === "1"; } catch { return false; }
}

interface HalloweenDecorState {
  window: { startsAt: number; endsAt: number };
  off: boolean;
  setWindow: (startsAt: string, endsAt: string) => void;
  setOff: (off: boolean) => void;
}

export const useHalloweenDecorStore = create<HalloweenDecorState>((set) => ({
  window: DEFAULT_WINDOW,
  off: typeof window === "undefined" ? false : readOff(),
  setWindow: (startsAt, endsAt) => {
    const s = Date.parse(startsAt);
    const e = Date.parse(endsAt);
    if (Number.isFinite(s) && Number.isFinite(e)) set({ window: { startsAt: s, endsAt: e } });
  },
  setOff: (off) => {
    try { if (off) localStorage.setItem(OFF_KEY, "1"); else localStorage.removeItem(OFF_KEY); } catch { /* private mode */ }
    set({ off });
  },
}));

/** Whether the Halloween season is on, regardless of the viewer's toggle. */
export function useHalloweenSeason(): boolean {
  const w = useHalloweenDecorStore((s) => s.window);
  const now = Date.now();
  return now >= w.startsAt && now < w.endsAt;
}

/** Whether to draw the decorations: in season and not switched off in Settings. */
export function useHalloweenDecor(): boolean {
  const season = useHalloweenSeason();
  const off = useHalloweenDecorStore((s) => s.off);
  return season && !off;
}
