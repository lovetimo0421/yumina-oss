import { isAnalyticsEnabled } from "./analytics-enabled";

const STORAGE_KEY = "__yumina_chunk_reload__";
const MAX_RELOADS = 2;

interface ReloadState {
  ts: number;
  count: number;
}

function readState(): ReloadState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ReloadState) : null;
  } catch {
    return null;
  }
}

function writeState(state: ReloadState): boolean {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function shouldReloadForChunkError(message: string | undefined | null) {
  if (!message) return false;
  return [
    "Failed to fetch dynamically imported module",
    "Importing a module script failed",
    "Expected a JavaScript-or-Wasm module script",
    'MIME type of "text/html"',
    "Load failed",
  ].some((pattern) => message.includes(pattern));
}

export function extractChunkErrorReason(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : null;
  }
  return null;
}

export function reloadOnceForChunkError(_reason: string): boolean {
  // Never blind-reload while offline: the reload would land on the browser's
  // offline error page AND burn a slot of the reload budget. Callers fall
  // through to the error UI / recoverFromChunkError, which waits for the
  // network instead.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;

  const prev = readState();

  if (prev && prev.count >= MAX_RELOADS) return false;

  if (!writeState({ ts: Date.now(), count: (prev?.count ?? 0) + 1 })) {
    return false;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("_r", String(Date.now()));
  window.location.replace(url.toString());
  return true;
}

export function clearChunkErrorFlag(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    const url = new URL(window.location.href);
    if (url.searchParams.has("_r")) {
      url.searchParams.delete("_r");
      window.history.replaceState(null, "", url.toString());
    }
  } catch {
    // no-op
  }
}

const CHUNK_URL_RE = /https?:\/\/[^\s"']+\.js/;

function extractChunkUrl(error: unknown): string | null {
  const msg = extractChunkErrorReason(error);
  if (!msg) return null;
  return msg.match(CHUNK_URL_RE)?.[0] ?? null;
}

interface ConnectionInfo {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

function diagnoseChunkFailure(error: unknown, action = "reload"): void {
  // No PostHog configured (open-source build): nothing to report to.
  if (!isAnalyticsEnabled()) return;
  try {
    import("posthog-js").then(({ default: posthog }) => {
      const chunkUrl = extractChunkUrl(error);
      const errorMsg = extractChunkErrorReason(error) ?? "unknown";

      const nav = navigator as Navigator & { connection?: ConnectionInfo };
      const conn = nav.connection;

      posthog.capture("chunk_load_diagnostic", {
        chunk_url: chunkUrl,
        error_message: errorMsg.substring(0, 500),
        error_type: error instanceof TypeError ? "TypeError"
          : error instanceof Error ? error.constructor.name
          : typeof error,
        action,
        online: navigator.onLine,
        connection_type: conn?.effectiveType,
        page_url: window.location.href,
        referrer: document.referrer,
      });
    });
  } catch {
    // Diagnostics must never break the recovery flow
  }
}

export type ChunkRecoveryOutcome = "reloading" | "give-up";

export interface ChunkRecoveryDeps {
  /** Resolves true when the URL produced ANY http response (404 included —
   *  that means the network path works and a reload will fetch a fresh
   *  chunk graph). False only on a network-level failure. */
  probe: (url: string) => Promise<boolean>;
  delay: (ms: number) => Promise<void>;
  isOnline: () => boolean;
  /** Resolve when the browser reports connectivity again (or on timeout). */
  waitForOnline: (timeoutMs: number) => Promise<boolean>;
  reload: (reason: string) => boolean;
}

/** Worst case ~20s of retrying before the manual error UI takes over. */
export const CHUNK_PROBE_BACKOFF_MS = [1_500, 3_000, 6_000, 10_000];

function defaultProbe(url: string): Promise<boolean> {
  return fetch(url, { cache: "no-store", credentials: "omit" })
    .then(() => true)
    .catch(() => false);
}

function defaultWaitForOnline(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("online", onOnline);
      resolve(false);
    }, timeoutMs);
    const onOnline = () => {
      window.clearTimeout(timer);
      resolve(true);
    };
    window.addEventListener("online", onOnline, { once: true });
  });
}

const defaultRecoveryDeps: ChunkRecoveryDeps = {
  probe: defaultProbe,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  waitForOnline: defaultWaitForOnline,
  reload: reloadOnceForChunkError,
};

/**
 * Weak-network-aware recovery for a failed chunk/resource load.
 *
 * The old behavior reloaded the page immediately on any chunk error. That is
 * right for a stale deploy (fresh index.html fixes it) but wrong on a flaky
 * connection: Safari reports plain network failures as "Load failed", each
 * blind reload re-downloads the whole app over the same dying connection, the
 * 2-reload budget burns in seconds, and the user dead-ends on the error screen
 * (the 2026-08-04 yuri88 "打开模拟器全都报错" report — simulator cards need
 * multi-MB sandbox/compiler chunks, so they died first on weak cellular).
 *
 * Now: probe the failing URL first. Only reload once a probe gets ANY http
 * response — proof the network path works and a reload can actually succeed.
 * While the network is down, wait/backoff instead of burning the budget.
 */
export async function recoverFromChunkError(
  error: unknown,
  overrides?: Partial<ChunkRecoveryDeps>
): Promise<ChunkRecoveryOutcome> {
  const deps: ChunkRecoveryDeps = { ...defaultRecoveryDeps, ...overrides };
  const reason = extractChunkErrorReason(error) ?? "chunk-error";
  const target = extractChunkUrl(error) ?? "/index.html";

  for (let attempt = 0; attempt <= CHUNK_PROBE_BACKOFF_MS.length; attempt++) {
    if (!deps.isOnline()) {
      await deps.waitForOnline(
        CHUNK_PROBE_BACKOFF_MS[Math.min(attempt, CHUNK_PROBE_BACKOFF_MS.length - 1)]!
      );
    }
    if (await deps.probe(target)) {
      return deps.reload(reason) ? "reloading" : "give-up";
    }
    if (attempt < CHUNK_PROBE_BACKOFF_MS.length) {
      await deps.delay(CHUNK_PROBE_BACKOFF_MS[attempt]!);
    }
  }
  return "give-up";
}

// ES module spec: once import() fails for a URL, the browser caches the failure
// in its module map. Retrying import() with the same URL is a no-op — the browser
// returns the cached error without re-fetching. The only recovery is a full page
// reload which clears the module map.
export async function importWithChunkRecovery<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    const reason = extractChunkErrorReason(error);
    if (!shouldReloadForChunkError(reason)) throw error;

    diagnoseChunkFailure(error, "recover");

    // While recovery probes/waits, the caller's <Suspense> fallback keeps
    // showing — strictly better than an instant doomed reload on a dead
    // connection.
    if ((await recoverFromChunkError(error)) === "reloading") {
      return await new Promise<T>(() => {});
    }

    diagnoseChunkFailure(error, "give-up");
    throw error;
  }
}
