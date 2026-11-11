/**
 * Find a model runtime already running on the player's own machine.
 *
 * We probe the default ports of the popular runtimes rather than asking the
 * player to type a URL — whichever one they already installed is the one they
 * should be able to use, and "paste your endpoint" is the step most people
 * quit on.
 *
 * The interesting part is telling "nothing installed" apart from "installed but
 * not allowed to talk to us", because those need completely different
 * instructions and guessing wrong sends the player down the wrong path. A
 * normal fetch rejects identically in both cases (a CORS refusal is opaque by
 * design), so a second `no-cors` probe breaks the tie: it still can't read the
 * response, but it resolves when something accepted the connection and rejects
 * when nothing is listening.
 */

export type RuntimeKind = "ollama" | "lmstudio" | "jan" | "llamacpp";

export interface RuntimeCandidate {
  kind: RuntimeKind;
  label: string;
  origin: string;
  /** Ollama speaks its own richer API; everyone else gets the OpenAI shape. */
  native: boolean;
}

export const RUNTIME_CANDIDATES: RuntimeCandidate[] = [
  { kind: "ollama", label: "Ollama", origin: "http://127.0.0.1:11434", native: true },
  { kind: "lmstudio", label: "LM Studio", origin: "http://127.0.0.1:1234", native: false },
  { kind: "jan", label: "Jan", origin: "http://127.0.0.1:1337", native: false },
  { kind: "llamacpp", label: "llama.cpp", origin: "http://127.0.0.1:8080", native: false },
];

/**
 * The window a local model runs at when we pick it. Mirrors the server's
 * DEFAULT_LOCAL_CONTEXT, which is what every local prompt is packed for.
 */
export const LOCAL_CONTEXT = 32_768;

export interface DetectedModel {
  id: string;
  name?: string;
  /**
   * The window this model runs at: the one LM Studio loaded it with, or the one
   * the bridge will load it at. Unset when the runtime doesn't say.
   */
  contextLength?: number;
  /** LM Studio only: whether the model is in memory right now. */
  loaded?: boolean;
  /** LM Studio only: the reasoning settings the model accepts, e.g. ["off", "on"]. */
  reasoningOptions?: string[];
}

/** One answering runtime and the chat models it offers. */
export interface RuntimeModels {
  runtime: RuntimeCandidate;
  models: DetectedModel[];
}

export type DetectionResult =
  /**
   * Reachable and readable — we can list models and run turns. `runtimes` is
   * every runtime that answered with models (Ollama AND LM Studio when both
   * run), best first; `runtime` and `models` are the lead one and the union.
   */
  | { status: "ready"; runtime: RuntimeCandidate; models: DetectedModel[]; runtimes: RuntimeModels[] }
  /** Something is listening, but it won't let this page read the response. */
  | { status: "blocked"; runtime: RuntimeCandidate }
  /** The browser refused this page access to the player's own machine. */
  | { status: "denied" }
  /** Nothing answered on any known port. */
  | { status: "none" };

const PROBE_TIMEOUT_MS = 1500;
/**
 * How long a probe may wait while Chrome's local-network prompt is up. The
 * request stays pending until the player answers, so the normal 1.5s would
 * give up mid-prompt and report "nothing installed" to someone who was about
 * to click Allow.
 */
const PERMISSION_PROMPT_TIMEOUT_MS = 60_000;

export type LoopbackPermission = "granted" | "prompt" | "denied" | "unknown";

/**
 * Chrome's Local Network Access gate on an https page reaching localhost.
 *
 * A denial makes every probe fail exactly like an empty machine, and the fix
 * is a site setting rather than an install, so the diagnosis needs to know it.
 * `loopback-network` is the current name; older Chromes only know
 * `local-network-access`. Browsers without either report "unknown".
 */
export async function loopbackPermission(): Promise<LoopbackPermission> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      const result = await navigator.permissions.query({ name } as unknown as PermissionDescriptor);
      return result.state;
    } catch {
      // Unknown permission name in this browser; try the next one.
    }
  }
  return "unknown";
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/** Ollama's native tag list carries the context length; the OpenAI shape doesn't. */
async function readOllamaModels(origin: string, signal?: AbortSignal): Promise<DetectedModel[]> {
  const res = await fetch(`${origin}/api/tags`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ model?: string; name?: string }> };
  return (body.models ?? [])
    .map((m) => ({ id: m.model ?? m.name ?? "" }))
    .filter((m) => m.id.length > 0);
}

/** Embedding models answer /v1/models like any other, but can't hold a conversation. */
const EMBEDDING_ID = /embed/i;

async function readOpenAiModels(origin: string, signal?: AbortSignal): Promise<DetectedModel[]> {
  const res = await fetch(`${origin}/v1/models`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? [])
    .map((m) => ({ id: m.id ?? "" }))
    .filter((m) => m.id.length > 0 && !EMBEDDING_ID.test(m.id));
}

interface LmStudioModel {
  type?: string;
  key?: string;
  display_name?: string;
  max_context_length?: number;
  loaded_instances?: Array<{ config?: { context_length?: number } }>;
  capabilities?: { reasoning?: { allowed_options?: unknown } };
}

interface LmStudioBetaModel {
  id?: string;
  type?: string;
  state?: string;
  loaded_context_length?: number;
}

/** Models already in memory first: they answer at once, the rest load first. */
function loadedFirst(models: DetectedModel[]): DetectedModel[] {
  return [...models].sort((a, b) => Number(b.loaded === true) - Number(a.loaded === true));
}

/**
 * LM Studio's own list says what /v1/models doesn't: which entries are
 * embedding models that can't chat, which are already loaded, and at what
 * context. 0.4+ serves it at /api/v1, 0.3 had a beta at /api/v0, and anything
 * older (or a server that isn't LM Studio after all) gets the OpenAI list.
 */
export async function readLmStudioModels(origin: string, signal?: AbortSignal): Promise<DetectedModel[]> {
  const native = await fetch(`${origin}/api/v1/models`, { signal });
  if (native.ok) {
    const body = (await native.json().catch(() => null)) as { models?: LmStudioModel[] } | null;
    if (Array.isArray(body?.models)) {
      return loadedFirst(body.models.flatMap((m): DetectedModel[] => {
        if (m.type !== "llm" || typeof m.key !== "string" || !m.key) return [];
        const instance = m.loaded_instances?.[0];
        const reasoning = m.capabilities?.reasoning?.allowed_options;
        // A model that isn't loaded yet is loaded by the bridge at our window
        // (see LocalBridge), capped at what the model itself supports.
        const contextLength = instance?.config?.context_length
          ?? (typeof m.max_context_length === "number" ? Math.min(m.max_context_length, LOCAL_CONTEXT) : undefined);
        return [{
          id: m.key,
          ...(typeof m.display_name === "string" && m.display_name && { name: m.display_name }),
          loaded: Boolean(instance),
          ...(typeof contextLength === "number" && contextLength > 0 && { contextLength }),
          ...(Array.isArray(reasoning) && { reasoningOptions: reasoning.filter((o): o is string => typeof o === "string") }),
        }];
      }));
    }
  }

  const beta = await fetch(`${origin}/api/v0/models`, { signal });
  if (beta.ok) {
    const body = (await beta.json().catch(() => null)) as { data?: LmStudioBetaModel[] } | null;
    if (Array.isArray(body?.data)) {
      return loadedFirst(body.data.flatMap((m): DetectedModel[] => {
        if (typeof m.id !== "string" || !m.id || m.type === "embeddings") return [];
        const loaded = m.state === "loaded";
        return [{
          id: m.id,
          loaded,
          ...(loaded && typeof m.loaded_context_length === "number" && { contextLength: m.loaded_context_length }),
        }];
      }));
    }
  }

  return readOpenAiModels(origin, signal);
}

/** The chat models a runtime offers right now. Throws when it can't be read. */
export function listRuntimeModels(runtime: RuntimeCandidate, signal?: AbortSignal): Promise<DetectedModel[]> {
  if (runtime.native) return readOllamaModels(runtime.origin, signal);
  if (runtime.kind === "lmstudio") return readLmStudioModels(runtime.origin, signal);
  return readOpenAiModels(runtime.origin, signal);
}

/** Did anything at all accept a connection here? Can't read the answer, only that there was one. */
async function isSomethingListening(origin: string, timeoutMs: number): Promise<boolean> {
  const { signal, done } = withTimeout(timeoutMs);
  try {
    await fetch(`${origin}/`, { mode: "no-cors", signal });
    return true;
  } catch {
    return false;
  } finally {
    done();
  }
}

type ReadyResult = Extract<DetectionResult, { status: "ready" }>;

/**
 * The ready result for a set of answering runtimes, best first. A model id two
 * runtimes share goes to the first, which is also where the bridge sends it.
 */
export function readyResult(runtimes: RuntimeModels[]): ReadyResult {
  const seen = new Set<string>();
  const models = runtimes.flatMap((r) => r.models).filter((m) => !seen.has(m.id) && Boolean(seen.add(m.id)));
  return { status: "ready", runtime: runtimes[0]!.runtime, models, runtimes };
}

/** "Ollama + LM Studio" — what the status line calls whatever is connected. */
export function runtimeNames(result: ReadyResult): string {
  return result.runtimes.map((r) => r.runtime.label).join(" + ");
}

async function probe(runtime: RuntimeCandidate, timeoutMs: number): Promise<RuntimeModels | DetectionResult | null> {
  const { signal, done } = withTimeout(timeoutMs);
  try {
    return { runtime, models: await listRuntimeModels(runtime, signal) };
  } catch {
    // Either nothing is there or it refused us. Ask the tie-breaker.
    if (await isSomethingListening(runtime.origin, timeoutMs)) {
      return { status: "blocked", runtime };
    }
    return null;
  } finally {
    done();
  }
}

/** Something loaded beats something installed beats an empty runtime. */
function usefulness(entry: RuntimeModels): number {
  if (entry.models.some((m) => m.loaded)) return 2;
  return entry.models.length > 0 ? 1 : 0;
}

/**
 * Order the runtimes that answered, best first, keeping only those with a
 * model to offer — unless none has one, when the best empty one stays so the
 * player hears "no models yet" instead of "nothing installed". Ollama starts
 * with Windows and often sits there empty for a player who uses LM Studio.
 */
export function rankRuntimes(entries: RuntimeModels[]): RuntimeModels[] {
  const ranked = [...entries].sort((a, b) => usefulness(b) - usefulness(a));
  const withModels = ranked.filter((r) => r.models.length > 0);
  return withModels.length > 0 ? withModels : ranked.slice(0, 1);
}

const isRuntimeModels = (r: unknown): r is RuntimeModels => !!r && typeof r === "object" && "runtime" in r && "models" in r;

/**
 * Probe every known runtime and return what's usable: every runtime that
 * answered with models (so LM Studio never pushes Ollama out, or the reverse),
 * otherwise a blocked one worth giving instructions for, otherwise nothing.
 *
 * All probes run together — sequential 1.5s timeouts across four dead ports
 * would be six seconds of staring at a spinner.
 */
export async function detectLocalRuntime(): Promise<DetectionResult> {
  const permission = await loopbackPermission();
  // Probe even when the permission reads "denied". A page served from this
  // same machine (the self-hosted edition on localhost) reaches its own ports
  // without it, and some embedded browsers deny it wholesale while letting
  // those requests through — trusting the flag reported a working LM Studio as
  // "blocked by your browser". Blame the permission only when nothing answered.
  const timeoutMs = permission === "prompt" ? PERMISSION_PROMPT_TIMEOUT_MS : PROBE_TIMEOUT_MS;
  const results = await Promise.all(RUNTIME_CANDIDATES.map((r) => probe(r, timeoutMs).catch(() => null)));
  const answered = results.filter(isRuntimeModels);
  if (answered.length > 0) return readyResult(rankRuntimes(answered));
  const blocked = results.find((r): r is Extract<DetectionResult, { status: "blocked" }> => !isRuntimeModels(r) && r?.status === "blocked");
  if (blocked) return blocked;
  // The player may have just answered the prompt with Block.
  if (permission === "denied" || (permission === "prompt" && (await loopbackPermission()) === "denied")) {
    return { status: "denied" };
  }
  return { status: "none" };
}
