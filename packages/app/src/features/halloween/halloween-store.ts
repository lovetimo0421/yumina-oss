import { create } from "zustand";
import { useHalloweenDecorStore } from "@/lib/halloween-decor";
import { useCreditStore } from "@/stores/credits";

const API = import.meta.env?.VITE_API_URL || "";

export const PUMPKIN_SPOTS = ["home", "play", "studio", "community", "settings"] as const;
export type PumpkinSpot = (typeof PUMPKIN_SPOTS)[number];

export interface HalloweenState {
  active: boolean;
  startsAt: string;
  endsAt: string;
  guest?: boolean;
  eligible?: boolean;
  found?: Partial<Record<PumpkinSpot, number>>;
  allFoundBonus?: number;
  allFoundClaimed?: boolean;
  turns?: { progress: number; goal: number; reward: number; claimed: boolean };
  total?: number;
}

export type PumpkinResult =
  | { kind: "opened"; amount: number; trick: boolean; allFound: boolean; bonus: number; balance: number }
  | { kind: "already"; amount: number }
  | { kind: "error"; code: string };

interface Store {
  state: HalloweenState | null;
  /** The account the state was loaded for, so switching accounts reloads it. */
  loadedFor: string | null;
  /** The event panel, opened from the top bar, the home banner or the Community card. */
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  load: (accountKey: string, force?: boolean) => Promise<void>;
  open: (spot: PumpkinSpot) => Promise<PumpkinResult>;
  claimTurns: () => Promise<{ ok: true; amount: number } | { ok: false; code: string }>;
}

export const useHalloweenStore = create<Store>((set, get) => ({
  state: null,
  loadedFor: null,
  panelOpen: false,
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  load: async (accountKey, force = false) => {
    if (!force && get().loadedFor === accountKey && get().state) return;
    try {
      const res = await fetch(`${API}/api/halloween`, { credentials: "include" });
      if (!res.ok) return;
      const body = await res.json() as { data: HalloweenState };
      useHalloweenDecorStore.getState().setWindow(body.data.startsAt, body.data.endsAt);
      set({ state: body.data, loadedFor: accountKey });
    } catch { /* offline: no event UI, decorations fall back to the built-in dates */ }
  },
  open: async (spot) => {
    try {
      const res = await fetch(`${API}/api/halloween/pumpkins/${spot}`, { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => ({})) as { data?: PumpkinResult; code?: string };
      if (!res.ok || !body.data) return { kind: "error", code: body.code ?? "NETWORK" };
      const result = body.data;
      const prev = get().state;
      if (prev && (result.kind === "opened" || result.kind === "already")) {
        const found = { ...(prev.found ?? {}), [spot]: result.amount };
        const added = result.kind === "opened" ? result.amount + result.bonus : 0;
        set({ state: {
          ...prev, found, total: (prev.total ?? 0) + added,
          allFoundClaimed: prev.allFoundClaimed || (result.kind === "opened" && result.bonus > 0),
        } });
      }
      if (result.kind === "opened") void useCreditStore.getState().fetchCredits(0);
      return result;
    } catch {
      return { kind: "error", code: "NETWORK" };
    }
  },
  claimTurns: async () => {
    try {
      const res = await fetch(`${API}/api/halloween/turns/claim`, { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => ({})) as { data?: { kind: string; amount?: number }; code?: string };
      if (!res.ok || !body.data) return { ok: false, code: body.code ?? "NETWORK" };
      const prev = get().state;
      const amount = body.data.amount ?? 0;
      if (prev?.turns) {
        set({ state: { ...prev, total: (prev.total ?? 0) + amount, turns: { ...prev.turns, claimed: true } } });
      }
      void useCreditStore.getState().fetchCredits(0);
      return { ok: true, amount };
    } catch {
      return { ok: false, code: "NETWORK" };
    }
  },
}));

export function halloweenRunning(state: HalloweenState | null): boolean {
  if (!state?.active) return false;
  const now = Date.now();
  return now >= Date.parse(state.startsAt) && now < Date.parse(state.endsAt);
}
