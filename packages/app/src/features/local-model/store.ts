/**
 * One place that knows whether this device is currently lending its GPU.
 *
 * Ties together the three moving parts: finding a runtime on this machine,
 * publishing its models into the pickers, and keeping the courier connection
 * alive. Components only ever call enable/disable and read `status`.
 */

import { create } from "zustand";
import { toast } from "sonner";
import i18n from "@/lib/i18n";
import { useModelsStore, type ModelInfo } from "@/stores/models";
import {
  detectLocalRuntime,
  LOCAL_CONTEXT,
  readyResult,
  runtimeNames,
  type DetectedModel,
  type DetectionResult,
  type RuntimeCandidate,
  type RuntimeModels,
} from "./detect";
import { LocalBridge, type BridgeStatus } from "./bridge";
import { isLocalModelArmed, setLocalModelArmed } from "./enabled-flag";

/** Pickers key everything off `local/`; the runtime knows the bare id. */
function toModelInfo(runtime: RuntimeCandidate, model: DetectedModel): ModelInfo {
  return {
    id: `local/${model.id}`,
    name: model.name ?? model.id,
    provider: `${runtime.label} (this device)`,
    // The server never packs more than LOCAL_CONTEXT, however big the window.
    contextLength: Math.min(model.contextLength ?? LOCAL_CONTEXT, LOCAL_CONTEXT),
    pricing: { prompt: 0, completion: 0 },
    isCurated: true,
  };
}

/** Every runtime's models into the pickers; an id two runtimes share goes to the first. */
function publishModels(runtimes: RuntimeModels[]): void {
  const seen = new Set<string>();
  const infos = runtimes.flatMap((r) => r.models.map((m) => toModelInfo(r.runtime, m)));
  useModelsStore.getState().setLocalModels(infos.filter((m) => !seen.has(m.id) && Boolean(seen.add(m.id))));
}

interface LocalModelState {
  /** The courier is live: the connection is up and the models are published. */
  enabled: boolean;
  /** The player asked for this and hasn't taken it back — survives reloads.
   *  Distinct from `enabled` because the two disagree exactly when it matters:
   *  armed but not enabled is "your runtime isn't answering", which is the one
   *  state worth putting in front of a player mid-game. */
  armed: boolean;
  detecting: boolean;
  detection: DetectionResult | null;
  status: BridgeStatus;
  error: string | null;

  detect: () => Promise<DetectionResult>;
  enable: () => Promise<void>;
  disable: () => void;
  /**
   * Reconnect on load when the player already turned this on. With `auto`
   * (see shouldAutoDetectLocalModel) also connect a player who never did,
   * to whatever runtime is running — or as soon as one starts.
   */
  resume: (opts?: { auto?: boolean }) => Promise<void>;

  /** Polling for the runtime after the player copied a setup command. */
  watching: boolean;
  /**
   * The player just copied a command to run outside the browser (install, or
   * let this site in). Keep checking, and connect the moment the runtime
   * answers, so coming back to the page is the last step rather than
   * "check again", then "turn on".
   */
  watchForRuntime: () => void;
  stopWatching: () => void;
}

let bridge: LocalBridge | null = null;
let watchTimer: ReturnType<typeof setTimeout> | null = null;
const WATCH_EVERY_MS = 4_000;
const WATCH_FOR_MS = 60 * 60_000;

export const useLocalModelStore = create<LocalModelState>((set, get) => ({
  enabled: false,
  armed: isLocalModelArmed(),
  detecting: false,
  detection: null,
  status: "idle",
  error: null,

  detect: async () => {
    set({ detecting: true, error: null });
    try {
      const detection = await detectLocalRuntime();
      set({ detection, detecting: false });
      return detection;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ detecting: false, error: message });
      return { status: "none" } as DetectionResult;
    }
  },

  enable: async () => {
    // Detection probes several ports and can take a second. Say "connecting"
    // for that window rather than leaving "idle" up, which any surface reading
    // this store renders as "can't reach your models" — wrong, and alarming
    // right after a reload.
    set({ status: "connecting" });
    const detection = get().detection?.status === "ready" ? get().detection : await get().detect();
    if (!detection || detection.status !== "ready") {
      // Nothing answered. Say so rather than returning quietly: this path is
      // reached on every reload of an armed browser whose runtime is closed,
      // and a silent no-op there reads as "the feature vanished".
      set({ status: "error" });
      return;
    }

    bridge?.stop();
    bridge = new LocalBridge({
      runtimes: detection.runtimes,
      onStatus: (status, detail) => set({ status, error: detail ?? null }),
      onRuntimes: (runtimes) => {
        publishModels(runtimes);
        set({ detection: readyResult(runtimes) });
      },
    });

    publishModels(detection.runtimes);

    await bridge.start();
    set({ enabled: true, armed: true });
    setLocalModelArmed(true);
  },

  disable: () => {
    bridge?.stop();
    bridge = null;
    // Drop the models too: leaving them in the picker after the courier is gone
    // would offer the player a model that can only fail.
    useModelsStore.getState().setLocalModels([]);
    set({ enabled: false, armed: false, status: "idle", error: null });
    setLocalModelArmed(false);
  },

  resume: async (opts) => {
    if (get().enabled) return;
    if (get().armed) {
      await get().enable();
      return;
    }
    if (!opts?.auto) return;
    const detection = await get().detect();
    if (detection.status === "ready" && detection.models.length > 0) await get().enable();
    // Not running, not allowing us yet, or no model downloaded: connect the
    // moment that changes. Only a browser-level denial can't fix itself.
    else if (detection.status !== "denied") get().watchForRuntime();
  },

  watching: false,

  watchForRuntime: () => {
    get().stopWatching();
    if (get().enabled) return;
    set({ watching: true });
    const startedAt = Date.now();
    const tick = async () => {
      watchTimer = null;
      if (!get().watching || get().enabled) { set({ watching: false }); return; }
      const found = await detectLocalRuntime().catch(() => null);
      if (!get().watching) return;
      if (found?.status === "ready" && found.models.length > 0) {
        set({ detection: found, watching: false });
        await get().enable();
        if (get().enabled) toast.success(i18n.t("profile:localModel.connectedToast", { runtime: runtimeNames(found) }));
        return;
      }
      // A blocked local-network permission never resolves by waiting: stop
      // and let the panel show how to allow it.
      if (found?.status === "denied") {
        set({ detection: found, watching: false });
        return;
      }
      // Anything else (e.g. Ollama mid-restart) isn't worth flashing at the player.
      if (Date.now() - startedAt > WATCH_FOR_MS) { set({ watching: false }); return; }
      watchTimer = setTimeout(() => void tick(), WATCH_EVERY_MS);
    };
    watchTimer = setTimeout(() => void tick(), WATCH_EVERY_MS);
  },

  stopWatching: () => {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
    if (get().watching) set({ watching: false });
  },
}));
