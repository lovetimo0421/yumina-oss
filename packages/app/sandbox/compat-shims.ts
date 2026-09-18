/**
 * Compatibility shims for the sandbox environment.
 *
 * These intercept browser APIs that existing worlds use (fetch, localStorage,
 * window.location, navigator.clipboard, window.__yuminaToggleImmersive) and
 * route them through the postMessage bridge to the parent.
 *
 * Design principle: DON'T migrate existing world code. Make old patterns work
 * transparently through the secure bridge. New worlds use the cleaner SDK.
 *
 * Must be called BEFORE any user code runs (from sandbox-host on mount).
 */

import { wrapMessage, postToParentWindow, type ApiCallMessage } from "./protocol";

// ── Async call infrastructure (shared with sandbox-context.ts) ──────

let shimCallCounter = 0;
const shimPendingCalls = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function shimCallParent<T>(method: string, args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const callId = `shim-${++shimCallCounter}`;
    shimPendingCalls.set(callId, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    const msg: ApiCallMessage = { type: "api-call", callId, method, args };
    postToParentWindow(wrapMessage(msg));

    setTimeout(() => {
      if (shimPendingCalls.has(callId)) {
        shimPendingCalls.delete(callId);
        reject(new Error(`Shim call '${method}' timed out`));
      }
    }, 15_000);
  });
}

function shimFireAndForget(method: string, args: unknown[]): void {
  const msg: ApiCallMessage = {
    type: "api-call",
    callId: `shim-fire-${++shimCallCounter}`,
    method,
    args,
  };
  postToParentWindow(wrapMessage(msg));
}

/** Called by sandbox-host when api-response arrives for shim calls */
export function resolveShimCall(callId: string, result: unknown): void {
  const pending = shimPendingCalls.get(callId);
  if (pending) {
    shimPendingCalls.delete(callId);
    pending.resolve(result);
  }
}

// ── State reference (updated by sandbox-host on each state push) ────

let currentSessionId = "";
let currentWorldId = "";

export function updateShimState(sessionId: string, worldId: string): void {
  currentSessionId = sessionId;
  currentWorldId = worldId;
}

// ── Install all shims ───────────────────────────────────────────────

export function installCompatShims(): void {
  shimFetch();
  shimLocation();
  shimStorage();
  shimToggleImmersive();
  shimClipboard();
}

// ── 1. fetch() → proxy through parent ───────────────────────────────
// Worlds call: fetch('/api/sessions/' + sid, { credentials: 'include' })
// Parent executes with real credentials, returns { status, body }

function shimFetch(): void {
  const _origFetch = window.fetch;

  window.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Only proxy /api/* requests — these need credentials the sandbox doesn't have
    if (url.startsWith("/api/") || url.startsWith("/api")) {
      const method = init?.method ?? "GET";
      const headers = init?.headers
        ? Object.fromEntries(
            init.headers instanceof Headers
              ? init.headers.entries()
              : Object.entries(init.headers as Record<string, string>)
          )
        : undefined;
      const body = init?.body
        ? typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body)
        : undefined;

      return shimCallParent<{ status: number; body: unknown }>("proxyFetch", [
        url,
        { method, headers, body },
      ]).then((result) => {
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      });
    }

    // CDN asset URLs — allow through (CSP img-src/font-src handles these)
    if (url.startsWith("/cdn/")) {
      try {
        return _origFetch.call(window, input, init);
      } catch {
        // CSP may block — return a rejected promise
        return Promise.reject(new Error("Network request blocked by sandbox"));
      }
    }

    // Everything else is blocked
    return Promise.reject(
      new Error(
        `Network requests to '${url}' are not available in the sandbox. Use useYumina() SDK methods instead.`
      )
    );
  };
}

// ── 2. window.location → synthetic location ─────────────────────────
// Worlds call: window.location.pathname.split('/').pop() to get session ID
// We provide a read-only object that matches the expected shape

function shimLocation(): void {
  const realOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://yumina.io";

  const locationShim = {
    get pathname() {
      return `/app/chat/${currentSessionId}`;
    },
    get href() {
      return `${realOrigin}/app/chat/${currentSessionId}`;
    },
    set href(url: string) {
      shimFireAndForget("navigate", [url]);
    },
    get origin() {
      return realOrigin;
    },
    get host() {
      return realOrigin.replace(/^https?:\/\//, "");
    },
    get hostname() {
      return realOrigin.replace(/^https?:\/\//, "").split(":")[0];
    },
    get protocol() {
      return "https:";
    },
    get search() {
      return "";
    },
    get hash() {
      return "";
    },
    get port() {
      return "";
    },
    // Redirect calls go through the parent
    assign(url: string) {
      shimFireAndForget("navigate", [url]);
    },
    replace(url: string) {
      shimFireAndForget("navigate", [url]);
    },
    reload() {
      shimFireAndForget("reloadSession", []);
    },
    toString() {
      return `${realOrigin}/app/chat/${currentSessionId}`;
    },
  };

  try {
    // In sandboxed iframes, window.location may be writable or configurable
    Object.defineProperty(window, "location", {
      get: () => locationShim,
      configurable: true,
    });
  } catch {
    // If we can't override window.location, at least provide it on a well-known name
    (window as any).__yuminaLocation = locationShim;
  }
}

// ── 3. localStorage/sessionStorage → per-world scoped via parent ────
// Worlds call: localStorage.getItem('key'), sessionStorage.setItem('key', 'value')
// We route through parent's localStorage, namespaced by worldId

function shimStorage(): void {
  const makeStorageShim = (
    prefix: string
  ): Storage => {
    const shim = {
      getItem(key: string): string | null {
        // Synchronous API but we need async — use a sync cache
        // The cache is populated on state push. For first access, return null.
        const fullKey = `yumina:${prefix}:${currentWorldId}:${key}`;
        try {
          // Try to read from parent synchronously via a shared approach
          // For now, return from an in-memory cache
          return storageCache.get(fullKey) ?? null;
        } catch {
          return null;
        }
      },
      setItem(key: string, value: string): void {
        const fullKey = `yumina:${prefix}:${currentWorldId}:${key}`;
        storageCache.set(fullKey, value);
        shimFireAndForget("storage.set", [fullKey, value]);
      },
      removeItem(key: string): void {
        const fullKey = `yumina:${prefix}:${currentWorldId}:${key}`;
        storageCache.delete(fullKey);
        shimFireAndForget("storage.remove", [fullKey]);
      },
      clear(): void {
        // Clear only this world's keys
        for (const k of storageCache.keys()) {
          if (k.startsWith(`yumina:${prefix}:${currentWorldId}:`)) {
            storageCache.delete(k);
          }
        }
        shimFireAndForget("storage.clear", [
          `yumina:${prefix}:${currentWorldId}:`,
        ]);
      },
      key(index: number): string | null {
        const keys = Array.from(storageCache.keys()).filter((k) =>
          k.startsWith(`yumina:${prefix}:${currentWorldId}:`)
        );
        return keys[index] ?? null;
      },
      get length(): number {
        return Array.from(storageCache.keys()).filter((k) =>
          k.startsWith(`yumina:${prefix}:${currentWorldId}:`)
        ).length;
      },
    };

    return shim as unknown as Storage;
  };

  try {
    Object.defineProperty(window, "localStorage", {
      get: () => makeStorageShim("local"),
      configurable: true,
    });
  } catch {
    // Sandboxed iframe may throw — that's fine, existing code will catch too
  }

  try {
    Object.defineProperty(window, "sessionStorage", {
      get: () => makeStorageShim("session"),
      configurable: true,
    });
  } catch {
    // Same
  }
}

// In-memory storage cache (populated by shim, persisted through parent)
const storageCache = new Map<string, string>();

/** Pre-populate storage cache from parent on init */
export function populateStorageCache(
  entries: Record<string, string>
): void {
  for (const [key, value] of Object.entries(entries)) {
    storageCache.set(key, value);
  }
}

// ── 4. window.__yuminaToggleImmersive → bridge call ─────────────────

function shimToggleImmersive(): void {
  Object.defineProperty(window, "__yuminaToggleImmersive", {
    get: () => () => shimFireAndForget("toggleImmersive", []),
    configurable: true,
  });
}

// ── 5. navigator.clipboard → bridge call ────────────────────────────
// Worlds call: navigator.clipboard.writeText(text)

function shimClipboard(): void {
  try {
    const clipboardShim = {
      writeText(text: string): Promise<void> {
        shimFireAndForget("copyToClipboard", [text]);
        return Promise.resolve();
      },
      readText(): Promise<string> {
        return Promise.reject(
          new Error("Clipboard read is not available in sandbox")
        );
      },
      write(): Promise<void> {
        return Promise.reject(
          new Error("Clipboard write is not available in sandbox")
        );
      },
      read(): Promise<ClipboardItems> {
        return Promise.reject(
          new Error("Clipboard read is not available in sandbox")
        );
      },
    };

    Object.defineProperty(navigator, "clipboard", {
      get: () => clipboardShim,
      configurable: true,
    });
  } catch {
    // navigator.clipboard may not be configurable in all environments
  }
}
