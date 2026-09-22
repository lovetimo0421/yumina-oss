import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PLAY_MODEL_IDS, DEFAULT_MODEL, DEFAULT_PINNED_MODELS, MAX_PINNED_MODELS, DEFAULT_POOL, DEFAULT_MIX_MODE } from "@yumina/shared";
import { DEFAULT_MODEL_FALLBACK_POLICY, type ModelFallbackPolicy } from "@yumina/shared";
import { AI_GENERATION_DEFAULTS } from "@yumina/shared";
import {
  MAX_POOL_SIZE,
  DEFAULT_WEIGHT,
  sanitizeModelPool,
  setModelPoolWeight,
  toggleModelPoolLock,
  type ModelPoolEntry,
} from "@/lib/model-mix";

// Guarded like lib/asset-url.ts: `import.meta.env` is a Vite build-time
// injection, and this module is also imported by the node test runner.
const apiBase = import.meta.env?.VITE_API_URL || "";
const PUSH_DEBOUNCE_MS = 800;
const MAX_PUSH_RETRIES = 4;
const MAX_PINNED = MAX_PINNED_MODELS;

/** Which model universe a pin belongs to. The official catalog and a user's
 *  BYOK catalog are disjoint, and each picker can only render ids from its own
 *  universe — so they get their own list and their own cap. */
export type PinScope = "official" | "private";

const PIN_KEY: Record<PinScope, "pinnedModels" | "pinnedPrivateModels"> = {
  official: "pinnedModels",
  private: "pinnedPrivateModels",
};

const SYNCED_KEYS = [
  "maxTokens",
  "maxContext",
  "storyMemory",
  "temperature",
  "topP",
  "frequencyPenalty",
  "presencePenalty",
  "repetitionPenalty",
  "topK",
  "minP",
  "reasoningEffort",
  "streaming",
  "selectedModel",
  "modelFallback",
  "pinnedModels",
  "pinnedPrivateModels",
  "mixMode",
  "modelPool",
] as const;
type SyncedKey = (typeof SYNCED_KEYS)[number];
const SYNCED_KEY_SET = new Set<string>(SYNCED_KEYS);

interface ConfigState {
  maxTokens: number;
  /** Hard ceiling on a whole request, lorebook included. */
  maxContext: number;
  /**
   * How much of the conversation stays word for word. The dial a player
   * actually turns, and the same on every plan.
   *
   * null = never chosen. It stays null rather than defaulting to the
   * suggestion, and a null is never sent to the server, because a sent value
   * counts as a deliberate choice and would cut an existing account's prompts
   * without them asking. The server decides what absence means.
   */
  storyMemory: number | null;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  repetitionPenalty: number;
  topK: number;
  minP: number;
  reasoningEffort: string;
  streaming: boolean;
  selectedModel: string;
  modelFallback: ModelFallbackPolicy;
  pinnedModels: string[];
  pinnedPrivateModels: string[];
  mixMode: boolean;
  modelPool: ModelPoolEntry[];

  setConfig: <K extends keyof ConfigValues>(key: K, value: ConfigValues[K]) => void;
  /** Returns false when the pin was rejected because the list is full, so the
   *  caller can say so. A star that silently refuses to light is a bug report. */
  pinModel: (id: string, scope: PinScope) => boolean;
  unpinModel: (id: string, scope: PinScope) => void;
  setPinnedModels: (ids: string[], scope: PinScope) => void;
  addToPool: (modelId: string) => void;
  removeFromPool: (modelId: string) => void;
  setPoolWeight: (modelId: string, weight: number) => void;
  togglePoolLock: (modelId: string) => void;
  resetPool: () => void;
  resetDefaults: () => void;
  /** Pull server-side aiConfig and merge in. No-op when not authed (401). */
  syncFromServer: () => Promise<void>;
  /** Hydrate BYOK pins from a freshly authenticated, account-validated profile.
   * Missing pins become empty; this never seeds local configuration to the server. */
  hydratePrivatePins: (accountId: string, aiConfig: unknown) => boolean;
  /** Force flush of pending debounced push (e.g., on tab close). */
  flushPendingPush: () => Promise<void>;
}

type ConfigValues = Pick<ConfigState, "maxTokens" | "maxContext" | "storyMemory" | "temperature" | "topP" | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty" | "topK" | "minP" | "reasoningEffort" | "streaming" | "selectedModel" | "modelFallback" | "mixMode" | "modelPool">;

const DEFAULTS: ConfigValues & { pinnedModels: string[]; pinnedPrivateModels: string[] } = {
  ...AI_GENERATION_DEFAULTS,
  storyMemory: null,
  selectedModel: DEFAULT_MODEL,
  modelFallback: { ...DEFAULT_MODEL_FALLBACK_POLICY },
  pinnedModels: [...DEFAULT_PINNED_MODELS],
  // Deliberately empty: nothing in a BYOK catalog is knowable up front, and a
  // seeded id the picker cannot render is a slot the user cannot reclaim.
  pinnedPrivateModels: [],
  mixMode: DEFAULT_MIX_MODE,
  modelPool: sanitizeModelPool([...DEFAULT_POOL] as ModelPoolEntry[]),
};

// Module-level push queue. The Zustand store stays a pure data container —
// the debounced PUT lives outside so multiple rapid setConfig() calls coalesce
// into one network request, and so hydrate-from-server can suppress the round
// trip via a flag without touching state shape.
let pendingPush: Partial<Record<SyncedKey, unknown>> = {};
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let suppressPush = false;
let pushFailures = 0;
// Intentionally unpersisted: localStorage alone cannot prove which login owns pins.
let privatePinsAccountId: string | null = null;

/** True while a local edit for this key has not been confirmed by the server.
 *  syncFromServer must not overwrite those keys with the server snapshot. */
function hasUnsentEdit(key: SyncedKey): boolean {
  return Object.prototype.hasOwnProperty.call(pendingPush, key);
}

async function pushPending() {
  pushTimer = null;
  const payload = pendingPush;
  pendingPush = {};
  if (Object.keys(payload).length === 0) return;

  let ok = false;
  try {
    const res = await fetch(`${apiBase}/api/users/me/ai-config`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Survive the request being fired from a tab that is going away. Without
      // this the beforeunload/pagehide flush is cancelled by the browser, the
      // server keeps the old blob, and the next load's syncFromServer reverts
      // the edit — which is how pinned models disappeared on refresh.
      keepalive: true,
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (ok) {
    pushFailures = 0;
    return;
  }

  // Failed (offline, 429 from the profile-updates limiter, blocked method,
  // aborted on unload). Put the values back so a later attempt re-sends them,
  // and never over a newer local edit that landed while this was in flight.
  for (const [key, value] of Object.entries(payload)) {
    if (!hasUnsentEdit(key as SyncedKey)) pendingPush[key as SyncedKey] = value;
  }
  if (pushFailures >= MAX_PUSH_RETRIES) return;
  pushFailures += 1;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(pushPending, PUSH_DEBOUNCE_MS * 2 ** pushFailures);
}

function schedulePush(key: SyncedKey, value: unknown) {
  if (suppressPush) return;
  pendingPush[key] = value;
  // A fresh user edit resets the backoff — retries should not stay slow just
  // because an earlier request failed.
  pushFailures = 0;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(pushPending, PUSH_DEBOUNCE_MS);
}

/** Persisted-state migration. Exported so the pin split can be tested without
 *  driving zustand's persist middleware. */
export function migrateConfig(persisted: unknown, version: number): Record<string, unknown> {
  const state = persisted as Record<string, unknown>;
  if (version < 1) {
    const ctx = state.maxContext as number | undefined;
    if (ctx !== undefined && ctx < 42_000) {
      state.maxContext = 42_000;
    }
  }
  if (version < 2) {
    const ctx = state.maxContext as number | undefined;
    if (ctx === 42_000) state.maxContext = 64_000;
    else if (ctx === 64_000) state.maxContext = 96_000;
  }
  if (version < 3) {
    if (typeof state.selectedModel === "string" && !PLAY_MODEL_IDS.has(state.selectedModel)) {
      state.selectedModel = DEFAULT_MODEL;
    }
    if (Array.isArray(state.pinnedModels)) {
      const cleaned = (state.pinnedModels as string[]).filter((id) => PLAY_MODEL_IDS.has(id));
      state.pinnedModels = cleaned.length > 0 ? cleaned : [...DEFAULT_PINNED_MODELS];
    }
  }
  if (version < 5) {
    if (typeof state.selectedModel === "string" && !PLAY_MODEL_IDS.has(state.selectedModel)) {
      state.selectedModel = DEFAULT_MODEL;
    }
    if (Array.isArray(state.pinnedModels)) {
      const cleaned = (state.pinnedModels as string[]).filter((id) => PLAY_MODEL_IDS.has(id));
      state.pinnedModels = cleaned.length > 0 ? cleaned : [...DEFAULT_PINNED_MODELS];
    }
  }
  if (version < 6) {
    if (state.mixMode === undefined) state.mixMode = false;
    if (!Array.isArray(state.modelPool)) state.modelPool = [];
  }
  if (version < 7) {
    const pool = state.modelPool as ModelPoolEntry[] | undefined;
    if (!pool || pool.length === 0) {
      state.modelPool = sanitizeModelPool([...DEFAULT_POOL] as ModelPoolEntry[]);
      state.mixMode = DEFAULT_MIX_MODE;
    }
  }
  if (version < 10 && state.repetitionPenalty === undefined) {
    state.repetitionPenalty = DEFAULTS.repetitionPenalty;
  }
  if (version < 11) {
    // One shared list used to hold both universes. Everything a BYOK picker
    // could actually render moves to the BYOK list; the official ids stay put.
    // Without this split the seeded defaults keep occupying BYOK slots.
    if (Array.isArray(state.pinnedModels) && !Array.isArray(state.pinnedPrivateModels)) {
      const all = state.pinnedModels as string[];
      state.pinnedPrivateModels = all.filter((id) => !PLAY_MODEL_IDS.has(id));
      state.pinnedModels = all.filter((id) => PLAY_MODEL_IDS.has(id));
    }
  }
  if (Array.isArray(state.modelPool)) {
    state.modelPool = sanitizeModelPool(state.modelPool as ModelPoolEntry[]);
  }
  return state;
}

export const useConfigStore = create<ConfigState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,

      setConfig: (key, value) => {
        const nextValue =
          key === "modelPool"
            ? sanitizeModelPool(value as ModelPoolEntry[])
            : value;
        set({ [key]: nextValue });
        if (SYNCED_KEY_SET.has(key as string)) {
          schedulePush(key as SyncedKey, nextValue);
        }
      },

      pinModel: (id, scope) => {
        const key = PIN_KEY[scope];
        const current = get()[key];
        if (current.includes(id)) return true;
        if (current.length >= MAX_PINNED) return false;
        const next = [...current, id];
        set({ [key]: next });
        schedulePush(key, next);
        return true;
      },

      unpinModel: (id, scope) =>
        set((s) => {
          const key = PIN_KEY[scope];
          const next = s[key].filter((m) => m !== id);
          schedulePush(key, next);
          return { [key]: next };
        }),

      setPinnedModels: (ids, scope) => {
        const key = PIN_KEY[scope];
        const next = ids.slice(0, MAX_PINNED);
        set({ [key]: next });
        schedulePush(key, next);
      },

      addToPool: (modelId) =>
        set((s) => {
          if (s.modelPool.length >= MAX_POOL_SIZE) return s;
          if (s.modelPool.some((e) => e.modelId === modelId)) return s;
          const next = sanitizeModelPool([...s.modelPool, { modelId, weight: DEFAULT_WEIGHT }]);
          schedulePush("modelPool", next);
          return { modelPool: next };
        }),

      removeFromPool: (modelId) =>
        set((s) => {
          const next = sanitizeModelPool(s.modelPool.filter((e) => e.modelId !== modelId));
          schedulePush("modelPool", next);
          if (next.length <= 1) {
            schedulePush("mixMode", false);
            return { modelPool: next, mixMode: false };
          }
          return { modelPool: next };
        }),

      setPoolWeight: (modelId, weight) =>
        set((s) => {
          const next = setModelPoolWeight(s.modelPool, modelId, weight);
          schedulePush("modelPool", next);
          return { modelPool: next };
        }),

      togglePoolLock: (modelId) =>
        set((s) => {
          const next = toggleModelPoolLock(s.modelPool, modelId);
          schedulePush("modelPool", next);
          return { modelPool: next };
        }),

      resetPool: () => {
        const pool = sanitizeModelPool([...DEFAULT_POOL] as ModelPoolEntry[]);
        const fallbackModel = pool[0]?.modelId ?? DEFAULT_MODEL;
        set({ modelPool: pool, mixMode: true, selectedModel: fallbackModel });
        schedulePush("modelPool", pool);
        schedulePush("mixMode", true);
        schedulePush("selectedModel", fallbackModel);
      },

      resetDefaults: () => {
        set(DEFAULTS);
        for (const k of SYNCED_KEYS) {
          schedulePush(k, DEFAULTS[k as keyof typeof DEFAULTS]);
        }
      },

      hydratePrivatePins: (accountId, aiConfig) => {
        const remote = aiConfig ?? {};
        if (!accountId || typeof remote !== "object" || Array.isArray(remote)) return false;
        const saved = remote as Record<string, unknown>;
        const legacy = saved.pinnedPrivateModels === undefined;
        const rawPins = legacy ? saved.pinnedModels ?? [] : saved.pinnedPrivateModels;
        if (!Array.isArray(rawPins) || rawPins.some(id => typeof id !== "string" || !id.trim())) return false;
        const pins = [...new Set(rawPins as string[])].filter(id => !legacy || !PLAY_MODEL_IDS.has(id));

        // A pending list with unknown/different ownership must never be merged
        // into the current account. Preserve this account's unsent edits on refresh.
        if (privatePinsAccountId !== accountId) {
          delete pendingPush.pinnedPrivateModels;
          if (Object.keys(pendingPush).length === 0 && pushTimer) {
            clearTimeout(pushTimer);
            pushTimer = null;
          }
        }
        privatePinsAccountId = accountId;
        if (!hasUnsentEdit("pinnedPrivateModels")) set({ pinnedPrivateModels: pins });
        return true;
      },

      syncFromServer: async () => {
        try {
          const res = await fetch(`${apiBase}/api/users/me/ai-config`, {
            credentials: "include",
          });
          if (!res.ok) return;
          const json = await res.json();
          const remote = (json?.data ?? null) as Record<string, unknown> | null;
          if (!remote || typeof remote !== "object") return;

          // Apply server values to local store for keys present remotely.
          const patch: Partial<ConfigState> = {};
          const seed: Partial<Record<SyncedKey, unknown>> = {};
          const current = get();

          // Blobs written before pins were scoped keep both universes in one
          // list. Split it here as well as in the persist migration: a device
          // with empty local state would otherwise seed an empty BYOK list over
          // the pins every other device can see.
          if (remote.pinnedPrivateModels === undefined && Array.isArray(remote.pinnedModels)) {
            const legacy = remote.pinnedModels as string[];
            remote.pinnedPrivateModels = legacy.filter((id) => !PLAY_MODEL_IDS.has(id));
            remote.pinnedModels = legacy.filter((id) => PLAY_MODEL_IDS.has(id));
          }
          for (const k of SYNCED_KEYS) {
            // A local edit that hasn't been confirmed by the server yet wins.
            // Otherwise a retrying push races its own GET and the server's old
            // value reverts the edit the user just made.
            if (hasUnsentEdit(k)) continue;
            if (remote[k] !== undefined) {
              (patch as Record<string, unknown>)[k] =
                k === "modelPool" && Array.isArray(remote[k])
                  ? sanitizeModelPool(remote[k] as ModelPoolEntry[])
                  : remote[k];
            } else {
              // Missing on server — seed our local value so other devices
              // see the same config on next sync.
              seed[k] = (current as unknown as Record<string, unknown>)[k];
            }
          }

          if (Object.keys(patch).length > 0) {
            suppressPush = true;
            try {
              set(patch as Partial<ConfigState>);
            } finally {
              suppressPush = false;
            }
          }

          // Single-shot upload of locally-known values. Bypasses the debounce
          // queue so it doesn't merge with pending user edits or re-fire on
          // every page load (the next sync sees these keys filled in).
          if (Object.keys(seed).length > 0) {
            try {
              await fetch(`${apiBase}/api/users/me/ai-config`, {
                method: "PUT",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(seed),
              });
            } catch {
              // silent — will retry next sync
            }
          }
        } catch {
          // silent — sync is best-effort
        }
      },

      flushPendingPush: async () => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        await pushPending();
      },
    }),
    {
      name: "yumina-global-config",
      version: 11,
      migrate: migrateConfig,
    }
  )
);
