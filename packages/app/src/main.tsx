import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { PostHogProvider } from "@posthog/react";
import { routeTree } from "./routeTree.gen";
import {
  recoverFromChunkError,
  reloadOnceForChunkError,
  shouldReloadForChunkError,
  clearChunkErrorFlag,
} from "@/lib/stale-chunk-reload";
import { installAudioUnlock } from "@/lib/ios-audio-unlock";
import { installRouteScrollRestoration } from "@/lib/route-scroll-restoration";
import { installDeployRefresh } from "@/lib/deploy-refresh";
import { clearReadingPageBootstrap } from "@/lib/reading-page-canvas";
import posthog from "posthog-js";
import type { CaptureResult } from "posthog-js";
import "@/styles/globals.css";
import { rememberArrival } from "@/lib/arrival-attribution";
import { isAnalyticsEnabled } from "@/lib/analytics-enabled";
import { getLandingRoute } from "@/edition/routes";

rememberArrival();

// Safari < 18.4 lacks requestIdleCallback — PostHog SDK uses it internally.
if (typeof window.requestIdleCallback === "undefined") {
  (window as unknown as Record<string, unknown>).requestIdleCallback = (cb: IdleRequestCallback) => window.setTimeout(cb, 1);
  (window as unknown as Record<string, unknown>).cancelIdleCallback = (id: number) => window.clearTimeout(id);
}

// Prime iOS audio on the first user gesture anywhere in the app, so that
// later programmatic audio.play() calls (SDK BGM, playlist tracks) don't get
// rejected by iOS's gesture-scope rule. No-op on desktop.
installAudioUnlock();

// Auto-reload when a dynamically imported chunk is stale (e.g., after a deploy).
// Vite emits this event when a lazy route or code-split chunk 404s.
window.addEventListener("vite:preloadError", (event) => {
  const reason =
    event instanceof ErrorEvent && event.message
      ? event.message
      : "vite:preloadError";
  if (reloadOnceForChunkError(reason)) {
    event.preventDefault();
  }
});

window.addEventListener("error", (event) => {
  if (shouldReloadForChunkError(event.message)) {
    reloadOnceForChunkError(event.message);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const reason =
    typeof event.reason === "string"
      ? event.reason
      : event.reason instanceof Error
        ? event.reason.message
        : null;

  if (shouldReloadForChunkError(reason)) {
    event.preventDefault();
    reloadOnceForChunkError(reason ?? "unhandledrejection");
  }
});


// ── Error-tracking noise filter (before_send) ───────────────────────────────
// Dropped classes (2026-07-06 error triage): device/network flakiness, browser
// extension internals, third-party script errors, autoplay policy rejections
// from creator world audio. None are actionable platform bugs, and together
// they were ~40% of the error-tracking pane. Real regressions in these shapes
// still surface elsewhere: chunk_load_diagnostic (asset fetch failures),
// llm_stream_failed (SSE drops), and server-side telemetry.
const SUPPRESSED_EXCEPTION_PATTERNS = [
  /^Load failed$/, // Safari's generic fetch/network failure
  /^Failed to fetch$/, // Chrome's generic fetch/network failure
  /NetworkError when attempting to fetch resource/, // Firefox's
  /Importing a module script failed/, // stale chunk — auto-reload recovers
  /Failed to fetch dynamically imported module/, // stale chunk — auto-reload recovers
  /ResizeObserver loop/, // benign browser reporting artifact
  /play\(\) can only be initiated by a user gesture/, // world audio vs autoplay policy
  /play\(\) failed because the user didn't interact/,
  /runtime\.sendMessage/, // browser extension internals
  /Extension context invalidated/,
  /Blocked a frame with origin/, // extensions/embeds probing cross-origin
  /Cloudflare Turnstile/, // third-party script's own errors
];
const EXTENSION_FRAME_RE = /^(chrome-extension|moz-extension|safari-extension|safari-web-extension):\/\//;

type ExceptionFrame = { filename?: string; source?: string };
type ExceptionEntry = { type?: string; value?: string; stacktrace?: { frames?: ExceptionFrame[] } };

function shouldDropException(list: ExceptionEntry[]): boolean {
  for (const entry of list) {
    const msg = entry.value ?? "";
    if (SUPPRESSED_EXCEPTION_PATTERNS.some((re) => re.test(msg))) return true;
    const sources = (entry.stacktrace?.frames ?? [])
      .map((f) => f.filename ?? f.source ?? "")
      .filter(Boolean);
    // Raised entirely inside a browser extension or a third-party script —
    // not our code on any frame.
    if (
      sources.length > 0 &&
      sources.every((s) => EXTENSION_FRAME_RE.test(s) || s.includes("challenges.cloudflare.com"))
    ) {
      return true;
    }
  }
  return false;
}

// PostHog — unified analytics, session replay, error tracking, web vitals
const posthogOptions = {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
  defaults: "2026-01-30",

  // SPA pageview tracking (fires on history.pushState, not full reloads)
  capture_pageview: "history_change" as const,
  capture_pageleave: true,

  // Autocapture: clicks, form submits, input changes, dead clicks
  autocapture: true,
  capture_dead_clicks: true,

  // Session replay: console logs + network timing visible in recordings
  disable_session_recording: false,
  enable_recording_console_log: true,
  session_recording: {
    // Don't record cross-origin iframes (sandbox has opaque origin, can't record anyway)
    recordCrossOriginIframes: false,
    maskAllInputs: true,
  },

  // Error tracking: replaces Sentry — errors link to session replays + user profiles
  capture_exceptions: {
    capture_unhandled_errors: true,
    capture_unhandled_rejections: true,
    capture_console_errors: false,
  },

  // Web vitals: LCP, CLS, FCP, INP + network performance entries
  capture_performance: {
    network_timing: true,
    web_vitals: true,
  },

  // Only create person profiles for identified (logged-in) users
  person_profiles: "identified_only" as const,

  // Noise filter + play-surface tagging for error tracking. Exceptions raised
  // while in a play session get tagged with the session id, so creator-world
  // fallout is filterable from platform bugs in the error pane.
  before_send: (event: CaptureResult | null): CaptureResult | null => {
    if (!event) return null;
    if (event.event === "$exception") {
      const list = (event.properties?.$exception_list ?? []) as ExceptionEntry[];
      if (shouldDropException(list)) return null;
      const play = window.location.pathname.match(/\/app\/chat\/([\w-]+)/);
      if (play && event.properties) {
        event.properties.play_session_id = play[1];
        event.properties.surface = "play";
      }
    }
    return event;
  },

  // Tag every event with the deploy that produced it (git SHA baked in at
  // Docker build via VITE_APP_RELEASE) — lets PostHog answer "which deploy
  // introduced this error".
  // Structural type: @posthog/react passes its own PostHogInterface here,
  // which is not the posthog-js PostHog class — register() is all we need.
  loaded: (ph: { register: (props: Record<string, string>) => void }) => {
    const release = import.meta.env.VITE_APP_RELEASE;
    if (release) ph.register({ app_release: release });
  },
} as const;

function extractErrorDetails(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) {
    return [error.message, error.stack].filter(Boolean).join("\n");
  }
  if (typeof error === "string") return error;
  try { return JSON.stringify(error, null, 2); } catch { return String(error); }
}

const DOM_MUTATION_ERRORS = [
  "insertBefore",
  "removeChild",
  "appendChild",
  "The node before which",
  "is not a child of this node",
];

function isDOMMutationError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return DOM_MUTATION_ERRORS.some((p) => msg.includes(p));
}

function isChunkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return shouldReloadForChunkError(msg);
}

// A lazy route can evaluate a chunk whose module namespace no longer matches
// the graph that imported it (a deploy replaced the chunks mid-session). The
// import itself succeeds, so the fetch-failure matchers above never fire —
// instead the route component reads an export that isn't there. Message is
// browser-specific: WebKit "undefined is not an object (evaluating
// 'e.LibraryPage')", Chrome "Cannot read properties of undefined (reading
// 'LibraryPage')". Recovery is the same as a failed chunk fetch: one reload
// to clear the module map (~90 users hit the dead-end error screen per 14d
// before this). PascalCase member is required so garden-variety null bugs
// (reading 'length' etc.) don't match.
const STALE_MODULE_GRAPH_RE =
  /undefined is not an object \(evaluating '[\w$]{1,3}\.[A-Z]\w*'\)|Cannot read properties of undefined \(reading '[A-Z]\w*'\)/;

function isStaleModuleGraphError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return STALE_MODULE_GRAPH_RE.test(msg);
}

function RouteErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  const details = extractErrorDetails(error);

  // Browser extensions (Google Translate, Grammarly, etc.) inject DOM nodes that
  // break React's virtual DOM reconciliation. Auto-recover instead of crashing.
  const domMutation = isDOMMutationError(error);
  const chunkError = !domMutation && (isChunkError(error) || isStaleModuleGraphError(error));

  // Chunk/resource failures get a probe-first recovery pass: reload only once
  // the network demonstrably works (stale deploy → instant reload as before),
  // otherwise wait out the connection blip with backoff instead of burning the
  // 2-reload budget on a dead connection (weak-cellular dead-end, 2026-08-04).
  const [recovering, setRecovering] = useState(chunkError);
  const capturedRef = useRef(false);

  useEffect(() => {
    if (!domMutation) return;
    console.warn("[RouteError] DOM mutation error (likely browser extension) — auto-recovering", error.message);
    const timer = setTimeout(reset, 0);
    return () => clearTimeout(timer);
  }, [domMutation, error, reset]);

  useEffect(() => {
    if (domMutation) return;

    if (!chunkError) {
      console.error("[RouteError]", error);
      if (details) console.error("[RouteError details]", details);
      if (!capturedRef.current) {
        capturedRef.current = true;
        try {
          if (isAnalyticsEnabled()) posthog.captureException(error, {
            url: window.location.href,
            chunk_reload_exhausted: false,
          });
        } catch { /* never break error display */ }
      }
      return;
    }

    let alive = true;
    void recoverFromChunkError(error).then((outcome) => {
      if (!alive || outcome === "reloading") return;
      setRecovering(false);
      console.error("[RouteError] chunk recovery exhausted", error);
      if (!capturedRef.current) {
        capturedRef.current = true;
        try {
          if (isAnalyticsEnabled()) posthog.captureException(error, {
            url: window.location.href,
            chunk_reload_exhausted: true,
          });
        } catch { /* never break error display */ }
      }
    });
    return () => { alive = false; };
  }, [domMutation, chunkError, error, details]);

  if (domMutation) return null;

  // Error UI copy is hardcoded bilingual (zh + en) on purpose: this screen must
  // render even when i18n or its lazy locale chunks are part of what failed.
  if (recovering) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm rounded-2xl border border-white/[0.06] bg-[#1A1B20] p-8 text-center shadow-2xl">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
          <h2 className="mb-1 text-lg font-semibold text-foreground">网络不稳定，正在重试…</h2>
          <p className="text-sm text-muted-foreground/50">
            Connection unstable — retrying automatically…
          </p>
        </div>
      </div>
    );
  }

  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const subtitle = chunkError
    ? offline
      ? "设备当前离线，请检查网络后重试。/ You appear to be offline. Check your connection and retry."
      : "资源加载失败，通常是网络不稳定所致，请重新加载。/ A resource failed to load — usually an unstable connection. Please reload."
    : "发生了意外错误。/ An unexpected error occurred.";

  // For chunk/import errors, "Try again" via React re-render is useless — the
  // browser's ES module map caches failures permanently within a page. Only a
  // full reload clears the module cache and retries the fetch.
  const handleRetry = chunkError
    ? () => window.location.reload()
    : reset;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/[0.06] bg-[#1A1B20] p-8 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <svg className="h-6 w-6 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="mb-1 text-lg font-semibold text-foreground">加载失败 / Something went wrong</h2>
        <p className="mb-6 text-sm text-muted-foreground/50">{subtitle}</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={handleRetry}
            className="rounded-xl bg-primary/90 px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary"
          >
            {chunkError ? "重新加载 / Reload page" : "重试 / Try again"}
          </button>
          <button
            onClick={() => { window.location.href = getLandingRoute(); }}
            className="rounded-xl bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
          >
            回到首页 / Go home
          </button>
        </div>
        {details && (
          <details className="mt-4 text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground/30">Error details</summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-black/30 p-2 text-xs text-destructive/70">
              {details}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

const router = createRouter({
  routeTree,
  defaultErrorComponent: RouteErrorFallback,
  // Router-owned entries keep window and nested scroller positions keyed to
  // the exact history entry, so safe Back navigation restores page position.
  scrollRestoration: true,
  // Keep old route visible while new route loads (prevents black flash)
  defaultPendingMs: 0,
  defaultPendingMinMs: 0,
  // Preload route chunks/loaders on hover (desktop) and touchstart (mobile).
  // Without this, a tap pays the full lazy-chunk fetch AFTER the tap — on
  // phone networks that reads as "I tapped and nothing happened".
  defaultPreload: "intent",
});

installRouteScrollRestoration(router);
installDeployRefresh(router);
router.subscribe("onResolved", (event) => clearReadingPageBootstrap(document, event.toLocation.pathname));

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// PostHog only wraps the tree when a project token is configured; the
// open-source edition ships without one and renders the router directly.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isAnalyticsEnabled() ? (
      <PostHogProvider
        apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN}
        options={posthogOptions}
      >
        <RouterProvider router={router} />
      </PostHogProvider>
    ) : (
      <RouterProvider router={router} />
    )}
  </StrictMode>
);

// Delay clearing the chunk-reload guard until lazy routes have settled.
// Must run AFTER initial route chunks load, not synchronously after render().
setTimeout(clearChunkErrorFlag, 8_000);

// Prewarm the sandbox bundle (~1.2MB JS + 333K CSS) during idle time so the
// first iframe mount doesn't block on a cold cache. Fire-and-forget.
import("@/lib/sandbox-prewarm").then((m) => m.prewarmSandbox()).catch(() => {});

// Prewarm the chat-view chunk so it's already loaded when the user first
// enters chat. This avoids lazy-import failures on flaky connections — if
// the initial page load succeeds, the chat chunk rides along with it.
import("@/features/chat/chat-view").catch(() => {});

// Service worker REMOVED (2026-05-29). The shell-caching SW served stale assets
// to clients returning from the background after a deploy (iOS especially),
// causing chunk-import failures, a reload loop, and a black screen that only a
// tab-close cleared (PostHog session 019e74cf-ece0-7609-bdcd-8932da610524).
// We no longer register it, so new visitors get no SW. `public/sw.js` is now a
// self-destruct stub: browsers that still have the old SW registered fetch it
// on their next visit (the browser's automatic update check, no register() call
// needed), and it clears caches + unregisters, recovering those clients.
// Telemetry (llm_stream_failed / chunk_load_diagnostic) will show if the
// original mobile-reconnect issue the SW was meant to fix actually returns.
