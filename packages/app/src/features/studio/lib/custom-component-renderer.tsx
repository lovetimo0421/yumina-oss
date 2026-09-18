import React, {
  useMemo,
  useContext,
  createContext,
  Component,
  useEffect,
  useRef,
} from "react";
import { compileTSX } from "./tsx-compiler";
import { useAssetFont } from "@/lib/asset-font";
import { resolveAssetRefs, resolveAssetUrl } from "@/lib/asset-url";
import { CopyErrorButton } from "@/components/copy-error-button";

/** API exposed to custom components via the useYumina() hook */
export interface YuminaAPI {
  mode?: "session" | "guest-preview";
  capabilities?: {
    canSendMessage: boolean;
    canPersistSession: boolean;
    canUseSessionApis: boolean;
    requiresAuth: boolean;
  };
  sendMessage: (text: string) => void;
  setVariable: (id: string, value: number | string | boolean | Record<string, unknown> | unknown[], options?: { scope?: string; targetUserId?: string }) => void;
  executeAction: (actionId: string) => void;
  navigateTo?: (path: string) => void;
  variables: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
  globalVariables: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
  worldName: string;
  /** The world's cover image ("Cover" in Studio) as an absolute URL, or null
   *  when unset. Tracks cover changes — prefer this over re-uploading the
   *  cover as an @asset for avatars/headers. */
  worldCover?: string | null;
  currentUser?: {
    id: string;
    name?: string;
    image?: string | null;
  } | null;
  /** Persona-aware user — same branching as {{user}}: active persona if set,
   *  else account. Prefer this over `currentUser` for in-world role-play
   *  rendering (chat bubbles, character cards, profile panels). */
  user?: { name: string; avatar: string | null };
  messages?: Array<Record<string, unknown>>;
  /** Whether the LLM is currently streaming a response */
  isStreaming?: boolean;
  /** Raw streaming content from the LLM (accumulated text chunks) */
  streamingContent?: string;
  /** Resolve an @asset:{id} reference to a CDN URL */
  resolveAssetUrl?: (ref: string) => string;
  /** Play an audio track by ID (must be defined in world audioTracks) */
  playAudio?: (trackId: string, opts?: { volume?: number; fadeDuration?: number; chainTo?: string; maxDuration?: number; duckBgm?: boolean }) => void;
  /** Stop a specific track, or all tracks if no ID given */
  stopAudio?: (trackId?: string, fadeDuration?: number) => void;
  /** Pause a track in place (resume continues from the same position) */
  pauseAudio?: (trackId: string) => void;
  /** Resume a track paused by pauseAudio */
  resumeAudio?: (trackId: string) => void;
  /** Subscribe to track-ended events; returns an unsubscribe function */
  onAudioEnded?: (cb: (trackId: string) => void) => () => void;
  /** Set volume for a category (bgm, sfx, or master) */
  setAudioVolume?: (type: "bgm" | "sfx" | "master", volume: number) => void;
  /** Get current volume for a category (bgm, sfx, or master) */
  getAudioVolume?: (type: "bgm" | "sfx" | "master") => number;
  /** Switch the greeting message to a different pre-written opening (by swipe index, 0-based) */
  switchGreeting?: (index: number) => void;
}

const defaultAPI: YuminaAPI = {
  sendMessage: () => {},
  setVariable: () => {},
  executeAction: () => {},
  variables: {},
  globalVariables: {},
  worldName: "",
  mode: "session",
  capabilities: {
    canSendMessage: true,
    canPersistSession: true,
    canUseSessionApis: true,
    requiresAuth: false,
  },
  currentUser: null,
  messages: [],
  playAudio: () => {},
  stopAudio: () => {},
  pauseAudio: () => {},
  resumeAudio: () => {},
  onAudioEnded: () => () => {},
  setAudioVolume: () => {},
  getAudioVolume: () => 1,
  switchGreeting: () => {},
};

const YuminaContext = createContext<YuminaAPI>(defaultAPI);

/**
 * The hook that compiled custom components call to interact with the game.
 * Reads from YuminaContext at call time, so it always gets the latest API.
 */
function useYumina(): YuminaAPI {
  return useContext(YuminaContext);
}

interface CustomComponentRendererProps {
  code: string;
  variables: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
  metadata?: Record<string, unknown>;
  worldName?: string;
  hostClassName?: string;
  /** When provided, enables interactive features (sendMessage, setVariable) */
  api?: YuminaAPI;
  /** Extra props spread onto the compiled component (e.g., content + role for message renderers) */
  extraProps?: Record<string, unknown>;
}

class ErrorBoundary extends Component<
  { children: React.ReactNode; fallback: (error: string) => React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error);
    }
    return this.props.children;
  }
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="relative rounded-lg border border-destructive/30 bg-destructive/5 p-3 pr-9">
      <p className="text-xs font-medium text-destructive">Component Error</p>
      <p className="mt-1 text-xs text-destructive/70 font-mono whitespace-pre-wrap break-all">{message}</p>
      <CopyErrorButton text={`Component Error:\n${message}`} />
    </div>
  );
}

function parseArbitraryColorToken(token: string, prefix: string): string | null {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = token.match(new RegExp(`^${escaped}\\[(.+)\\]$`));
  if (!m) return null;
  const raw = m[1]?.trim() ?? "";
  if (!raw) return null;
  // Restrict to common CSS color/value chars to avoid invalid style injection.
  if (!/^[#(),.%\s\-+/_a-zA-Z0-9]+$/.test(raw)) return null;
  return raw;
}

/** Tracked listeners so we can remove them on cleanup */
export type TrackedListener = { el: HTMLElement; type: string; fn: EventListener };

export function applyRuntimeStyleFixes(root: ParentNode, tracked: TrackedListener[]): void {
  const elements = root.querySelectorAll<HTMLElement>("[class]");
  elements.forEach((el) => {
    const tokens = Array.from(el.classList);
    let hoverBg: string | null = null;
    let hoverBorder: string | null = null;
    let hoverText: string | null = null;

    for (const token of tokens) {
      const bg = parseArbitraryColorToken(token, "bg-");
      if (bg) {
        el.style.backgroundColor = bg;
        continue;
      }
      const text = parseArbitraryColorToken(token, "text-");
      if (text) {
        el.style.color = text;
        continue;
      }
      const border = parseArbitraryColorToken(token, "border-");
      if (border) {
        el.style.borderColor = border;
        continue;
      }
      hoverBg = hoverBg ?? parseArbitraryColorToken(token, "hover:bg-");
      hoverBorder = hoverBorder ?? parseArbitraryColorToken(token, "hover:border-");
      hoverText = hoverText ?? parseArbitraryColorToken(token, "hover:text-");
    }

    if ((hoverBg || hoverBorder || hoverText) && !el.dataset.yuminaHoverBound) {
      el.dataset.yuminaHoverBound = "1";
      const enterFn: EventListener = () => {
        if (hoverBg) {
          if (!el.dataset.yuminaOrigBg) el.dataset.yuminaOrigBg = el.style.backgroundColor || "";
          el.style.backgroundColor = hoverBg!;
        }
        if (hoverBorder) {
          if (!el.dataset.yuminaOrigBorder) el.dataset.yuminaOrigBorder = el.style.borderColor || "";
          el.style.borderColor = hoverBorder!;
        }
        if (hoverText) {
          if (!el.dataset.yuminaOrigText) el.dataset.yuminaOrigText = el.style.color || "";
          el.style.color = hoverText!;
        }
      };
      const leaveFn: EventListener = () => {
        if (hoverBg) el.style.backgroundColor = el.dataset.yuminaOrigBg ?? "";
        if (hoverBorder) el.style.borderColor = el.dataset.yuminaOrigBorder ?? "";
        if (hoverText) el.style.color = el.dataset.yuminaOrigText ?? "";
      };
      el.addEventListener("mouseenter", enterFn);
      el.addEventListener("mouseleave", leaveFn);
      tracked.push({ el, type: "mouseenter", fn: enterFn });
      tracked.push({ el, type: "mouseleave", fn: leaveFn });
    }
  });
}

export function hardenImages(root: ParentNode, tracked: TrackedListener[]): void {
  const images = root.querySelectorAll<HTMLImageElement>("img");
  images.forEach((img) => {
    if (!img.getAttribute("referrerpolicy")) {
      img.setAttribute("referrerpolicy", "no-referrer");
    }

    // Resolve @asset:{id} references in img src
    const src = img.getAttribute("src");
    if (src && src.startsWith("@asset:") && !img.dataset.yuminaAssetResolved) {
      img.dataset.yuminaAssetResolved = "1";
      resolveAssetUrl(src).then((resolved) => {
        if (resolved !== src) img.src = resolved;
      });
    }

    if (!img.dataset.yuminaRetryBound) {
      img.dataset.yuminaRetryBound = "1";
      const errorFn: EventListener = () => {
        if (!img.dataset.yuminaRetried) {
          img.dataset.yuminaRetried = "1";
          const errSrc = img.getAttribute("src");
          if (!errSrc) return;
          const sep = errSrc.includes("?") ? "&" : "?";
          img.src = `${errSrc}${sep}_cb=${Date.now()}`;
        }
      };
      img.addEventListener("error", errorFn);
      tracked.push({ el: img, type: "error", fn: errorFn });
    }
  });
}

export async function resolveStyleAssetRefs(root: ParentNode): Promise<void> {
  const styleTags = root.querySelectorAll<HTMLStyleElement>("style");
  for (const styleEl of styleTags) {
    const cssText = styleEl.textContent ?? "";
    if (!cssText.includes("@asset:")) continue;
    const resolved = await resolveAssetRefs(cssText);
    if (resolved !== cssText) {
      styleEl.textContent = resolved;
    }
  }

  const styledElements = root.querySelectorAll<HTMLElement>("[style]");
  for (const el of styledElements) {
    const styleAttr = el.getAttribute("style") ?? "";
    if (!styleAttr.includes("@asset:")) continue;
    const resolved = await resolveAssetRefs(styleAttr);
    if (resolved !== styleAttr) {
      el.setAttribute("style", resolved);
    }
  }
}

/**
 * Rewrite simple `@media (max-width: N)` / `@media (min-width: N)` rules inside
 * `<style>` tags to `@container (max-width: N)` / `@container (min-width: N)`.
 *
 * Use case: studio preview canvas. The preview container shrinks to 375px for
 * the phone frame, but CSS `@media` queries resolve against the browser's
 * viewport (~1440px on a laptop) so mobile breakpoints never activate and the
 * preview misrepresents the real device experience. Marking the preview
 * wrapper as a CSS container (`container-type: inline-size`) and converting
 * width-based `@media` to `@container` makes the rules resolve against the
 * wrapper's width instead — the preview matches what players actually see.
 *
 * Only applies to studio preview (playtime uses a real iframe where `@media`
 * already resolves correctly). Only rewrites simple width-only queries so
 * compound or non-width queries (`orientation`, `prefers-color-scheme`,
 * `hover`, resolution) are left untouched and continue to work as-is.
 *
 * Idempotent — sets a `data-yumina-container-rewritten="1"` marker on style
 * tags so MutationObserver loops don't re-process the same element.
 */
// Matches: @media (max-width: N), @media screen and (max-width: N), etc.,
// but only when immediately followed by `{` so compound queries
// (`@media (max-width: N) and (orientation: portrait)`) are left alone and
// still resolve against the viewport.
const SIMPLE_WIDTH_MEDIA_RE = /@media\s+(?:(?:only\s+|not\s+)?screen\s+and\s+)?\(\s*(max|min)-width\s*:\s*([^)]+?)\s*\)\s*{/g;

export function rewriteMediaToContainerQueries(root: ParentNode): void {
  const styleTags = root.querySelectorAll<HTMLStyleElement>("style");
  for (const styleEl of styleTags) {
    if (styleEl.dataset.yuminaContainerRewritten === "1") continue;
    const cssText = styleEl.textContent ?? "";
    if (!cssText.includes("@media")) {
      styleEl.dataset.yuminaContainerRewritten = "1";
      continue;
    }
    const rewritten = cssText.replace(SIMPLE_WIDTH_MEDIA_RE, "@container ($1-width: $2) {");
    if (rewritten !== cssText) {
      styleEl.textContent = rewritten;
    }
    styleEl.dataset.yuminaContainerRewritten = "1";
  }
}

/**
 * Rewrite top-level `:root`, `html`, `body` selectors inside `<style>` tags
 * to `:host` so they keep working when the component is rendered inside a
 * Shadow Root.
 *
 * Use case: studio canvas wraps user TSX in a Shadow Root for style
 * isolation. Inside a shadow root, `:root` / `html` / `body` don't match
 * anything (those elements live in the host document, outside the shadow
 * tree). A card defining
 *   :root { --gold: #d4af37; --cream: #f0e6d2; }
 *   body  { font-family: serif; }
 * would lose every theme variable and font cascade in the canvas preview
 * unless the selectors are remapped onto the shadow host. `:host` is the
 * shadow-DOM equivalent and CSS custom properties declared on it inherit
 * to all descendants in the shadow tree.
 *
 * Conservative scope — only rewrites when the entire selector list of a
 * rule consists of `:root`, `html`, and/or `body` (e.g., `:root`,
 * `html, body`, `:root, html, body`). Compound forms like `:root.dark`,
 * `body[data-theme]`, `body > .foo` are left alone: getting them right
 * needs `:host(.dark)` / `:host([data-theme])` rewrites that vary by
 * combinator, and the safe fallback (no rewrite) at worst makes the rule
 * a no-op rather than producing a malformed selector. The same patterns
 * already break inside Yumina's playtime iframe sandbox, so creators have
 * already adapted to put theme tokens on a wrapper class instead.
 *
 * Idempotent — sets a `data-yumina-shadow-rewritten="1"` marker so
 * MutationObserver loops don't re-process the same element.
 */
// Anchor: start of stylesheet OR after a previous rule (`{`, `}`, `;`),
// followed by optional whitespace. Selector list: one or more of
// :root / html / body separated by commas. Trailing whitespace then `{`.
// Capture groups 1–2 preserve the anchor character and leading whitespace
// so we can splice them back into the replacement.
const SHADOW_ROOT_RULE_RE = /(^|[{};])(\s*)((?::root|html|body)(?:\s*,\s*(?::root|html|body))*)(?=\s*\{)/g;

export function rewriteShadowRootSelectors(root: ParentNode): void {
  const styleTags = root.querySelectorAll<HTMLStyleElement>("style");
  for (const styleEl of styleTags) {
    if (styleEl.dataset.yuminaShadowRewritten === "1") continue;
    const cssText = styleEl.textContent ?? "";
    // Cheap fast-path: skip the regex unless one of the targets appears.
    if (!/(?::root|\bhtml\b|\bbody\b)/.test(cssText)) {
      styleEl.dataset.yuminaShadowRewritten = "1";
      continue;
    }
    const rewritten = cssText.replace(
      SHADOW_ROOT_RULE_RE,
      (_match, anchor: string, ws: string) => `${anchor}${ws}:host`,
    );
    if (rewritten !== cssText) {
      styleEl.textContent = rewritten;
    }
    styleEl.dataset.yuminaShadowRewritten = "1";
  }
}

export function CustomComponentRenderer({
  code,
  variables,
  metadata = {},
  worldName = "",
  hostClassName,
  api,
  extraProps,
}: CustomComponentRendererProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // The effective API merges caller-provided actions with live state
  const effectiveAPI = useMemo<YuminaAPI>(
    () => ({
      sendMessage: api?.sendMessage ?? defaultAPI.sendMessage,
      setVariable: api?.setVariable ?? defaultAPI.setVariable,
      executeAction: api?.executeAction ?? defaultAPI.executeAction,
      navigateTo: api?.navigateTo,
      switchGreeting: api?.switchGreeting,
      variables: api?.variables ?? variables,
      globalVariables: api?.globalVariables ?? api?.variables ?? variables,
      worldName,
      currentUser: api?.currentUser ?? null,
      messages: api?.messages ?? [],
      isStreaming: api?.isStreaming,
      streamingContent: api?.streamingContent,
      playAudio: api?.playAudio,
      stopAudio: api?.stopAudio,
      pauseAudio: api?.pauseAudio,
      resumeAudio: api?.resumeAudio,
      onAudioEnded: api?.onAudioEnded,
      setAudioVolume: api?.setAudioVolume,
      getAudioVolume: api?.getAudioVolume,
      resolveAssetUrl: (ref: string) => {
        if (!ref) return ref;
        if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
        if (ref.startsWith("@asset:")) return `/cdn/${ref.slice(7)}`;
        return ref;
      },
    }),
    [api, variables, worldName, api?.currentUser, api?.messages, api?.isStreaming, api?.streamingContent]
  );

  // Compile once per code change. The useYumina hook reads from context,
  // so it always gets the latest effectiveAPI via the Provider below.
  const { Component: CompiledComponent, error } = useMemo(
    () => compileTSX(code, useYumina, { useAssetFont }),
    [code]
  );

  if (error) {
    return <ErrorCard message={error} />;
  }

  if (!CompiledComponent) {
    return <ErrorCard message="No component exported" />;
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const trackedListeners: TrackedListener[] = [];
    let suppressObserver = false;

    const process = () => {
      // Suppress observer while we mutate styles to avoid feedback loop
      suppressObserver = true;
      applyRuntimeStyleFixes(host, trackedListeners);
      hardenImages(host, trackedListeners);
      void resolveStyleAssetRefs(host);
      if (typeof document !== "undefined" && document.head) {
        void resolveStyleAssetRefs(document.head);
      }
      // Re-enable observer on next microtask (after style mutations settle)
      queueMicrotask(() => { suppressObserver = false; });
    };

    process();

    let rafId: number | null = null;
    const scheduleProcess = () => {
      if (suppressObserver || rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        process();
      });
    };

    const observer = new MutationObserver(scheduleProcess);
    observer.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "src"],
    });

    const headObserver =
      typeof document !== "undefined" && document.head
        ? new MutationObserver(scheduleProcess)
        : null;
    headObserver?.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href"],
    });

    return () => {
      observer.disconnect();
      headObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      // Remove all tracked event listeners
      for (const { el, type, fn } of trackedListeners) {
        el.removeEventListener(type, fn);
      }
      trackedListeners.length = 0;
    };
  }, [code]);

  return (
    <YuminaContext.Provider value={effectiveAPI}>
      <ErrorBoundary fallback={(err) => <ErrorCard message={err} />}>
        <div ref={hostRef} className={hostClassName}>
          <CompiledComponent
            variables={variables}
            metadata={metadata}
            worldName={worldName}
            {...(extraProps ?? {})}
          />
        </div>
      </ErrorBoundary>
    </YuminaContext.Provider>
  );
}
