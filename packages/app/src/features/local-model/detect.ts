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

export interface DetectedModel {
  id: string;
  name?: string;
  contextLength?: number;
}

export type DetectionResult =
  /** Reachable and readable — we can list models and run turns. */
  | { status: "ready"; runtime: RuntimeCandidate; models: DetectedModel[] }
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
 * is a site setting rather than an install, so it has to be read before the
 * probes run. `loopback-network` is the current name; older Chromes only know
 * `local-network-access`. Browsers without either report "unknown" and skip
 * the gate entirely.
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
async function readOllamaModels(origin: string, signal: AbortSignal): Promise<DetectedModel[]> {
  const res = await fetch(`${origin}/api/tags`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ model?: string; name?: string }> };
  return (body.models ?? [])
    .map((m) => ({ id: m.model ?? m.name ?? "" }))
    .filter((m) => m.id.length > 0);
}

async function readOpenAiModels(origin: string, signal: AbortSignal): Promise<DetectedModel[]> {
  const res = await fetch(`${origin}/v1/models`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => ({ id: m.id ?? "" })).filter((m) => m.id.length > 0);
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

async function probe(runtime: RuntimeCandidate, timeoutMs: number): Promise<DetectionResult | null> {
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const models = runtime.native
      ? await readOllamaModels(runtime.origin, signal)
      : await readOpenAiModels(runtime.origin, signal);
    return { status: "ready", runtime, models };
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

/**
 * Probe every known runtime and return the best answer: a usable one if any,
 * otherwise a blocked one worth giving instructions for, otherwise nothing.
 *
 * All probes run together — sequential 1.5s timeouts across four dead ports
 * would be six seconds of staring at a spinner.
 */
export async function detectLocalRuntime(): Promise<DetectionResult> {
  const permission = await loopbackPermission();
  if (permission === "denied") return { status: "denied" };
  const timeoutMs = permission === "prompt" ? PERMISSION_PROMPT_TIMEOUT_MS : PROBE_TIMEOUT_MS;
  const results = await Promise.all(RUNTIME_CANDIDATES.map((r) => probe(r, timeoutMs).catch(() => null)));
  const ready = results.find((r): r is Extract<DetectionResult, { status: "ready" }> => r?.status === "ready");
  if (ready) return ready;
  const blocked = results.find((r): r is Extract<DetectionResult, { status: "blocked" }> => r?.status === "blocked");
  if (blocked) return blocked;
  // The player may have just answered the prompt with Block.
  if (permission === "prompt" && (await loopbackPermission()) === "denied") return { status: "denied" };
  return { status: "none" };
}
