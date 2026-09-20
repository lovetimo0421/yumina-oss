import { create } from "zustand";
import { useCreditStore } from "@/edition/slots.state";
import { useUserProfileStore } from "./user-profile";
import { composeSelectedModelId } from "@/lib/model-id";
import { PLAY_MODELS, type CostTier, type TimeBasedAvgCostMushies } from "@yumina/shared";
import type { ModelCostStats } from "@yumina/shared";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  pricing?: { prompt: number; completion: number };
  isCurated: boolean;
  minPlan?: string;
  tier?: CostTier;
  avgCostMushies?: number;
  avgCostMushiesByPeriod?: TimeBasedAvgCostMushies;
  /** Measured mushies per reply (server, last 7 days). Preferred over avgCostMushies when present. */
  costStats?: ModelCostStats;
  badge?: string;
}

interface ModelsState {
  models: ModelInfo[];
  curated: ModelInfo[];
  recentlyUsed: string[];
  loading: boolean;
  lastFetched: number;
  /** Identifier for the data source the cache was filled from. Switching
   *  Yumina/private mode, or active private profiles, invalidates the cache. */
  lastSourceKey: string;

  fetchModels: () => Promise<void>;
  search: (query: string) => ModelInfo[];
  addToRecent: (modelId: string) => void;
}

interface ApiKeyEntry {
  id: string;
  provider: string;
  metadata: {
    models?: string[];
    defaultModel?: string;
  } | null;
  createdAt: string;
}

const apiBase = import.meta.env?.VITE_API_URL || "";
const RECENT_KEY = "yumina-recent-models";
const CACHE_TTL = 5 * 60 * 1000;
let requestVersion = 0;
let pendingSource: string | null = null;

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** Map a provider value (custom/openai/google/...) to a human-readable display
 *  string, mirroring the curated-models conventions used by the official picker. */
function providerDisplayName(provider: string): string {
  const map: Record<string, string> = {
    custom: "Custom",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    openrouter: "OpenRouter",
    ollama: "Ollama",
  };
  return map[provider] ?? provider;
}

function providerDisplayFromModelId(modelId: string): string {
  const prefix = modelId.split("/")[0] ?? "";
  const map: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    "meta-llama": "Meta",
    mistralai: "Mistral",
    deepseek: "DeepSeek",
    cohere: "Cohere",
    "x-ai": "xAI",
    "z-ai": "Z.ai",
    "nousresearch": "Nous Research",
    openrouter: "OpenRouter",
    custom: "Custom",
  };
  return map[prefix] ?? prefix;
}

function buildOfficialFallbackModels(): ModelInfo[] {
  return PLAY_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    provider: providerDisplayFromModelId(model.id),
    contextLength: 0,
    isCurated: true,
    minPlan: model.minPlan,
    tier: model.tier as CostTier,
    avgCostMushies: model.avgCostMushies,
    avgCostMushiesByPeriod: model.avgCostMushiesByPeriod,
    badge: model.badge,
  }));
}

export function resolveModelSourceKey(
  creditProvider: "official" | "private",
  creditLastFetched: number,
  preferences?: Record<string, unknown> | null,
): string {
  const preferredFromProfile =
    preferences?.preferredProvider === "private" || preferences?.preferredProvider === "official"
      ? preferences.preferredProvider
      : null;
  const preferredProvider = creditLastFetched > 0
    ? creditProvider
    : preferredFromProfile ?? creditProvider;
  const activeKeyId = typeof preferences?.activeApiKeyId === "string"
    ? preferences.activeApiKeyId
    : null;

  if (preferredProvider !== "private") return "official";

  // Private mode is still private even before an active profile is selected.
  // Server-side routing can fall back to a matching/recent BYOK key, so the UI
  // should keep showing saved private catalogs instead of silently reverting
  // to official models.
  return activeKeyId ? `private:${activeKeyId}` : "private:auto";
}

/** Which pin list a source key's model ids belong to. Pins are scoped to the
 *  catalog they came from — an official id cannot render in a BYOK picker and
 *  vice versa, so each catalog owns its own list. */
export function pinScopeFromSourceKey(sourceKey: string): "official" | "private" {
  return sourceKey.startsWith("private:") ? "private" : "official";
}

/** Snapshot the data source we should fetch from, derived from the user's
 *  preferred provider + active key. Profile preferences can resolve private
 *  mode before the credits/status request finishes, which matters on Studio
 *  routes where the top-bar credit widget is hidden. */
function resolveSource(): { kind: "official" } | { kind: "private"; activeKeyId: string | null } {
  const credits = useCreditStore.getState();
  const profile = useUserProfileStore.getState().profile;
  const sourceKey = resolveModelSourceKey(
    credits.provider,
    credits.lastFetched,
    profile?.preferences ?? null,
  );
  if (sourceKey.startsWith("private:")) {
    const activeKeyId = sourceKey.slice("private:".length);
    return {
      kind: "private",
      activeKeyId: activeKeyId === "auto" ? null : activeKeyId,
    };
  }
  return { kind: "official" };
}

function sourceCacheKey(source: ReturnType<typeof resolveSource>): string {
  return source.kind === "private" ? `private:${source.activeKeyId ?? "auto"}` : "official";
}

function buildPrivateModelInfos(provider: string, rawModels: string[]): ModelInfo[] {
  const display = providerDisplayName(provider);
  const models: ModelInfo[] = [];
  for (const bare of rawModels) {
    const id = composeSelectedModelId(provider, bare);
    if (!id) continue;
    models.push({
      id,
      name: bare,
      provider: display,
      contextLength: 0,
      isCurated: false,
    });
  }
  return models;
}

function dedupeModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

async function fetchApiKeyEntries(): Promise<ApiKeyEntry[]> {
  const res = await fetch(`${apiBase}/api/keys`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load private model profiles");
  const { data } = await res.json();
  return Array.isArray(data) ? data : [];
}

function savedPrivateModels(
  source: Extract<ReturnType<typeof resolveSource>, { kind: "private" }>,
  entries: ApiKeyEntry[],
): ModelInfo[] {
  const targetEntries = source.activeKeyId
    ? entries.filter((entry) => entry.id === source.activeKeyId)
    : entries;

  // If profile.activeApiKeyId is stale/deleted, fall back to saved BYOK
  // catalogs. The selected model id still determines server-side routing.
  const effectiveEntries = targetEntries.length > 0 ? targetEntries : entries;

  return dedupeModels(
    effectiveEntries.flatMap((entry) =>
      buildPrivateModelInfos(entry.provider, [
        ...(entry.metadata?.models ?? []),
        ...(entry.metadata?.defaultModel ? [entry.metadata.defaultModel] : []),
      ]),
    ),
  );
}

async function fetchLivePrivateModels(
  source: Extract<ReturnType<typeof resolveSource>, { kind: "private" }>,
  entries: ApiKeyEntry[],
): Promise<ModelInfo[]> {
  const active = entries.find((entry) => entry.id === source.activeKeyId);
  const targets = active ? [active] : entries;
  const models = await Promise.all(targets.map(async (target) => {
    const fallback = savedPrivateModels({ kind: "private", activeKeyId: target.id }, [target]);
    try {
      const res = await fetch(`${apiBase}/api/keys/${target.id}/list-models?refresh=auto`, {
        method: "POST",
        credentials: "include",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return fallback;
      const { data } = await res.json();
      if (!data?.ok || !Array.isArray(data.models)) return fallback;
      const ids = data.models.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
      if (ids.length === 0) return fallback;
      return dedupeModels(buildPrivateModelInfos(target.provider, [
        ...ids,
        ...(target.metadata?.defaultModel ? [target.metadata.defaultModel] : []),
      ]));
    } catch {
      return fallback;
    }
  }));
  return dedupeModels(models.flat());
}

/** Read the private catalog for an extension without changing story/provider state. */
export async function fetchPrivateModelCatalog(): Promise<ModelInfo[]> {
  const preferences = useUserProfileStore.getState().profile?.preferences;
  const activeKeyId = typeof preferences?.activeApiKeyId === "string" ? preferences.activeApiKeyId : null;
  const source = { kind: "private" as const, activeKeyId };
  const entries = await fetchApiKeyEntries();
  const cached = savedPrivateModels(source, entries);
  return cached.length ? cached : fetchLivePrivateModels(source, entries);
}

export const useModelsStore = create<ModelsState>((set, get) => ({
  models: [],
  curated: [],
  recentlyUsed: loadRecent(),
  loading: false,
  lastFetched: 0,
  lastSourceKey: "",

  fetchModels: async () => {
    const source = resolveSource();
    const sourceKey = sourceCacheKey(source);
    const now = Date.now();
    const fresh =
      get().models.length > 0 &&
      now - get().lastFetched < CACHE_TTL &&
      get().lastSourceKey === sourceKey;
    if (fresh) return;
    if (pendingSource === sourceKey) return;
    pendingSource = sourceKey;
    const version = ++requestVersion;
    const isCurrent = () => version === requestVersion && sourceCacheKey(resolveSource()) === sourceKey;

    // Source switched (or first fetch after one): wipe the previous source's
    // models before the network round-trip so consumers do not briefly render
    // stale ids. Pickers gate Recent/Pinned by lastSourceKey === expected, so
    // resetting lastSourceKey also hides stale rows until the new fetch lands.
    if (get().lastSourceKey !== "" && get().lastSourceKey !== sourceKey) {
      set({ models: [], curated: [], lastSourceKey: "" });
    }

    set({ loading: true });
    try {
      if (source.kind === "private") {
        // Mirror the AI Configuration panel first. That panel displays saved
        // metadata.models, so Studio should not go blank just because an
        // upstream /models endpoint is temporarily unavailable.
        const entries = await fetchApiKeyEntries();
        if (!isCurrent()) return;
        const cached = savedPrivateModels(source, entries);
        if (cached.length > 0) {
          set({ models: cached, curated: cached, loading: false, lastSourceKey: sourceKey });
        }
        const composed = await fetchLivePrivateModels(source, entries);
        if (!isCurrent()) return;

        set({
          models: composed,
          // In private mode, every surfaced model is from the user's key, so
          // curated == all for the browser's highlighted section.
          curated: composed,
          loading: false,
          lastFetched: now,
          lastSourceKey: sourceKey,
        });
        return;
      }

      // Official Yumina API mode (default).
      const res = await fetch(`${apiBase}/api/models`, {
        credentials: "include",
      });
      if (!res.ok) {
        if (isCurrent()) set({ loading: false });
        return;
      }
      const { data } = await res.json();
      if (!isCurrent()) return;
      const allFromApi = Array.isArray(data?.all) ? (data.all as ModelInfo[]) : [];
      const officialById = new Map(PLAY_MODELS.map((model) => [model.id, model]));
      const officialOnly = PLAY_MODELS.map((model) => {
        const fromApi = allFromApi.find((entry) => entry.id === model.id);
        return {
          id: model.id,
          name: model.name,
          provider: fromApi?.provider ?? providerDisplayFromModelId(model.id),
          contextLength: fromApi?.contextLength ?? 0,
          pricing: fromApi?.pricing,
          isCurated: true,
          minPlan: model.minPlan,
          tier: model.tier as CostTier,
          avgCostMushies: model.avgCostMushies,
          avgCostMushiesByPeriod: model.avgCostMushiesByPeriod,
          costStats: fromApi?.costStats,
          badge: model.badge,
        } satisfies ModelInfo;
      });
      const fallbackOfficial = buildOfficialFallbackModels();
      const finalOfficial = officialOnly.length > 0 ? officialOnly : fallbackOfficial;
      const curatedFinal = finalOfficial.filter((entry) => officialById.has(entry.id));
      set({
        models: finalOfficial,
        curated: curatedFinal,
        loading: false,
        lastFetched: now,
        lastSourceKey: sourceKey,
      });
    } catch {
      if (isCurrent()) set({ loading: false });
    } finally {
      if (version === requestVersion) pendingSource = null;
    }
  },

  search: (query: string) => {
    const q = query.toLowerCase();
    return get().models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  },

  addToRecent: (modelId: string) => {
    set((s) => {
      const filtered = s.recentlyUsed.filter((id) => id !== modelId);
      const updated = [modelId, ...filtered].slice(0, 10);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
      } catch {
        // ignore
      }
      return { recentlyUsed: updated };
    });
  },
}));
